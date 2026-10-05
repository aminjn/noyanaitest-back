import mongoose from "mongoose";
import { Request } from "express";
import AppError, { NotFoundError } from "../../AppError";
import User from "../../../Models/User";
import BizContact, { IBizContact } from "../../../Models/BizContact";
import BizLinkOffer, { BizLinkSource, IBizLinkOffer } from "../../../Models/BizLinkOffer";
import BizConsentLog, { BizConsentAction, IBizConsentLog } from "../../../Models/BizConsentLog";
import { BizOwner } from "../coa";
import { orgInfo } from "../campaign";
import { normalizeMobile } from "../crm";
import { crmLink, DAY, isId, notify, oid, ownerOfDoc } from "./common";

// Patient-consented record linking (2026-10). A centre adds its patients
// itself (by hand, a CSV import or its web form /f/<slug>); those contacts
// were never tied to the patient's Noyan account, so «باشگاه‌های من» and
// «پیام به مراکز» did not show them. Now:
//   - a contact whose mobile equals a user's verified phone (the login
//     phone: login is SMS OTP only, and an admin phone change ends every
//     session, so a live session proves the phone) becomes an offer to that
//     user - never a link;
//   - the patient links it («وصل شود»), says «این من نیستم» (never offered
//     again; the centre sees a possible wrong number) or «بعداً» (asked
//     again in a week), and can unlink it later;
//   - contacts made by real Noyan visits and orders stay tied by the visit
//     sync (Lib/business/crm.ts), logged with source "visit";
//   - every step goes to BizConsentLog (append-only), with IP, user agent
//     and the matched phone, so it can be produced if there is a complaint.
// Doctolib / Docplanner keep the practice's patient file and the patient's
// account apart and share between them only with the patient's explicit
// consent (GDPR art. 6/9); Paziresh24 ties bookings to the OTP-verified
// mobile. Noyan does both: the match is on the OTP phone, the link is the
// patient's own act.

export type Meta = { ip?: string; userAgent?: string };
type Offer = IBizLinkOffer;

const SNOOZE_DAYS = 7;
const REFRESH_MS = 60_000;

export const metaOf = (req: Request): Meta => ({
  ip: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 60) || undefined,
  userAgent: String(req.headers["user-agent"] || "").slice(0, 400) || undefined,
});

// 0912***4567
export const maskPhone = (p?: string | null) => (p && p.length >= 8 ? `${p.slice(0, 4)}***${p.slice(-4)}` : "");

// a small per-user limit on the patient's endpoints (in memory, per process)
const hits = new Map<string, number[]>();
export const rateLimit = (key: string, max: number, windowMs = 10 * 60_000) => {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  if (list.length > max) throw new AppError("تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره امتحان کنید", 429);
};

// how the centre came to have this contact
export const sourceOf = (c: Pick<IBizContact, "source" | "via">): BizLinkSource =>
  c.source === "visit" || c.source === "order" ? "visit" : c.source === "import" ? "csv" : c.via === "webform" ? "webform" : "manual";

// the user's verified mobile, 09xxxxxxxxx
export const verifiedMobile = (user?: { phone?: string } | null) => normalizeMobile(user?.phone);

const nameOf = async (owner: BizOwner) => (await orgInfo(owner).catch(() => ({ name: "" }))).name || "";

export const writeLog = async (
  rows: (Omit<Partial<IBizConsentLog>, "_id" | "at"> & { action: BizConsentAction; user: unknown; contact: unknown; ownerKind: string; ownerId: unknown; source: BizLinkSource; phone: string })[],
  meta?: Meta,
) => {
  if (!rows.length) return;
  await BizConsentLog.insertMany(
    rows.map((r) => ({ actor: "system", ...r, ...(meta?.ip ? { ip: meta.ip } : {}), ...(meta?.userAgent ? { userAgent: meta.userAgent } : {}), at: new Date() })),
  );
};

const logOffer = (o: Offer, action: BizConsentAction, ownerName: string, extra: { actor?: "patient" | "system"; reason?: string } = {}, meta?: Meta) =>
  writeLog(
    [
      {
        user: o.user,
        contact: o.contact,
        ownerKind: o.ownerKind,
        ownerId: o.ownerId,
        ownerName,
        offer: o._id,
        action,
        actor: extra.actor || "system",
        source: o.source,
        phone: o.phone,
        ...(extra.reason ? { reason: extra.reason } : {}),
      },
    ],
    meta,
  );

// ---------------------------------------------------------------- offers

// Offers these contacts (all of `phone`, none linked) to the user: one per
// (contact, user), never twice, never for a centre the user is already
// linked to. Race-safe through the unique index.
const offerContacts = async (userId: unknown, phone: string, contacts: IBizContact[], meta?: Meta) => {
  if (!contacts.length) return 0;
  const uid = oid(userId);
  const [existing, mine] = await Promise.all([
    BizLinkOffer.find({ user: uid, contact: { $in: contacts.map((c) => c._id) } }).select("contact").lean<{ contact: unknown }[]>(),
    BizContact.find({ user: uid, isActive: { $ne: false } }).select("ownerKind ownerId").lean<IBizContact[]>(),
  ]);
  const had = new Set(existing.map((e) => String(e.contact)));
  const linkedAt = new Set(mine.map((c) => `${c.ownerKind}:${c.ownerId}`));
  let made = 0;
  for (const c of contacts) {
    if (had.has(String(c._id)) || c.user || c.isActive === false || c.ownerKind === "platform") continue;
    if (c.phone !== phone || linkedAt.has(`${c.ownerKind}:${c.ownerId}`)) continue;
    const r = await BizLinkOffer.updateOne(
      { contact: c._id, user: uid },
      {
        $setOnInsert: {
          ownerKind: c.ownerKind,
          ownerId: c.ownerId,
          contact: c._id,
          user: uid,
          phone,
          source: sourceOf(c),
          status: "pending",
          offeredAt: new Date(),
        },
      },
      { upsert: true },
    ).catch(() => null);
    if (!r?.upsertedCount) continue;
    made++;
    const o = await BizLinkOffer.findOne({ contact: c._id, user: uid }).lean<Offer>();
    if (!o) continue;
    const owner = ownerOfDoc(c);
    const name = await nameOf(owner);
    await logOffer(o, "offered", name, {}, meta);
    if (name)
      await notify(
        uid,
        "پرونده‌ی شما در یک مرکز",
        `«${name}» شما را به‌عنوان بیمار یا مشتری ثبت کرده است. برای وصل‌شدن پرونده به حساب نویان، آن را در «پیام به مراکز» تأیید کنید`,
        "/dashboard/centres",
      );
  }
  return made;
};

// A centre just added or imported contacts: offer them to the Noyan users
// of those phones. Called without waiting; it never fails the centre's
// request.
export const offerNewContacts = async (owner: BizOwner, phones: string[]) => {
  const list = [...new Set(phones.map((p) => normalizeMobile(p)).filter((p): p is string => !!p))];
  if (!list.length || owner.kind === "platform") return;
  const users = await User.find({ phone: { $in: list.map((p) => `98${p.slice(1)}`) }, status: { $ne: "deleted" } })
    .select("phone")
    .lean<{ _id: unknown; phone: string }[]>();
  if (!users.length) return;
  const contacts = await BizContact.find({
    ownerKind: owner.kind,
    ownerId: oid(owner.id),
    phone: { $in: users.map((u) => verifiedMobile(u)).filter(Boolean) },
    user: { $in: [null] },
  }).lean<IBizContact[]>();
  for (const u of users) {
    const phone = verifiedMobile(u);
    if (phone) await offerContacts(u._id, phone, contacts.filter((c) => c.phone === phone));
  }
};
export const offerNewContactsLater = (owner: BizOwner, phones: string[]) => {
  offerNewContacts(owner, phones).catch((err) => console.log("[crm link] offer failed:", err));
};

// Brings the user's offers up to date (at most once a minute): pending
// offers of an old phone or of a contact now gone or linked elsewhere are
// withdrawn, and every unlinked contact of the current phone is offered.
const lastRefresh = new Map<string, number>();
export const refreshOffers = async (user: { _id: unknown; phone?: string }, meta?: Meta, force = false) => {
  const key = String(user._id);
  if (!force && Date.now() - (lastRefresh.get(key) || 0) < REFRESH_MS) return;
  lastRefresh.set(key, Date.now());
  if (lastRefresh.size > 20000) lastRefresh.clear();
  const phone = verifiedMobile(user);
  const uid = oid(user._id);
  const pending = await BizLinkOffer.find({ user: uid, status: "pending" }).lean<Offer[]>();
  if (pending.length) {
    const contacts = new Map(
      (await BizContact.find({ _id: { $in: pending.map((o) => o.contact) } }).select("user isActive phone").lean<IBizContact[]>()).map((c) => [String(c._id), c]),
    );
    for (const o of pending) {
      const c = contacts.get(String(o.contact));
      const reason =
        o.phone !== phone
          ? "phoneChanged"
          : !c || c.isActive === false || c.phone !== o.phone
            ? "contactGone"
            : c.user && String(c.user) !== key
              ? "linkedElsewhere"
              : null;
      if (!reason) continue;
      const done = await BizLinkOffer.findOneAndUpdate({ _id: o._id, status: "pending" }, { $set: { status: "withdrawn", withdrawnAt: new Date() } }, { new: true }).lean<Offer>();
      if (done) await logOffer(done, "withdrawn", await nameOf(ownerOfDoc(o)), { reason }, meta);
    }
  }
  if (!phone) return;
  const contacts = await BizContact.find({ phone, user: { $in: [null] }, isActive: { $ne: false }, ownerKind: { $ne: "platform" } })
    .limit(200)
    .lean<IBizContact[]>();
  await offerContacts(user._id, phone, contacts, meta);
};

// what the patient sees before confirming: the centre's name and kind,
// nothing of the contact itself
// (only those of the current verified phone, even between refreshes)
export const pendingOffers = async (user: { _id: unknown; phone?: string }) => {
  const phone = verifiedMobile(user);
  if (!phone) return [];
  const now = new Date();
  const rows = await BizLinkOffer.find({
    user: oid(user._id),
    phone,
    status: "pending",
    $or: [{ snoozedUntil: { $exists: false } }, { snoozedUntil: null }, { snoozedUntil: { $lte: now } }],
  })
    .sort({ offeredAt: -1 })
    .limit(20)
    .lean<Offer[]>();
  const out = [];
  for (const o of rows) {
    const centre = await nameOf(ownerOfDoc(o));
    if (centre) out.push({ _id: o._id, ownerKind: o.ownerKind, ownerId: o.ownerId, centre, offeredAt: o.offeredAt });
  }
  return out;
};

const myOffer = async (userId: unknown, offerId: string) => {
  if (!isId(offerId)) throw new NotFoundError();
  const o = await BizLinkOffer.findOne({ _id: offerId, user: oid(userId) }).lean<Offer>();
  if (!o) throw new NotFoundError();
  return o;
};

const withdraw = async (o: Offer, reason: string, meta?: Meta) => {
  const done = await BizLinkOffer.findOneAndUpdate(
    { _id: o._id, status: { $in: ["pending", "unlinked"] } },
    { $set: { status: "withdrawn", withdrawnAt: new Date() } },
    { new: true },
  ).lean<Offer>();
  if (done) await logOffer(done, "withdrawn", await nameOf(ownerOfDoc(o)), { reason }, meta);
};

// «وصل شود»: a pending offer of the user's current phone, or a record they
// unlinked themselves earlier. Idempotent: linking a linked one is a no-op.
export const linkOffer = async (user: { _id: unknown; phone?: string }, offerId: string, meta: Meta) => {
  const o = await myOffer(user._id, offerId);
  const key = String(user._id);
  if (o.status === "linked") {
    const c = await BizContact.findOne({ _id: o.contact, user: oid(key) }).select("_id").lean();
    if (c) return { status: "linked" as const, already: true };
  }
  if (o.status !== "pending" && o.status !== "unlinked" && o.status !== "linked") throw new AppError("این پیشنهاد دیگر معتبر نیست", 409);
  if (o.status === "pending" && o.phone !== verifiedMobile(user)) {
    await withdraw(o, "phoneChanged", meta);
    throw new AppError("این پیشنهاد دیگر معتبر نیست", 409);
  }
  // one record per centre per account
  const other = await BizContact.exists({ ownerKind: o.ownerKind, ownerId: o.ownerId, user: oid(key), _id: { $ne: o.contact } });
  if (other) throw new AppError("پرونده‌ی دیگری از شما در این مرکز وصل است", 409);
  const c = await BizContact.findOneAndUpdate(
    { _id: o.contact, isActive: { $ne: false }, $or: [{ user: { $exists: false } }, { user: null }, { user: oid(key) }] },
    { $set: { user: oid(key) } },
    { new: true },
  ).lean<IBizContact>();
  if (!c) {
    const gone = !(await BizContact.exists({ _id: o.contact, isActive: { $ne: false } }));
    await withdraw(o, gone ? "contactGone" : "linkedElsewhere", meta);
    throw new AppError("این پیشنهاد دیگر معتبر نیست", 409);
  }
  const done = await BizLinkOffer.findOneAndUpdate(
    { _id: o._id, status: { $in: ["pending", "unlinked", "linked"] } },
    { $set: { status: "linked", linkedAt: new Date() }, $unset: { snoozedUntil: 1, unlinkedAt: 1 } },
    { new: true },
  ).lean<Offer>();
  if (done && o.status !== "linked") await logOffer(done, "linked", await nameOf(ownerOfDoc(o)), { actor: "patient" }, meta);
  // the contact is now this user's: nobody else is offered it
  for (const x of await BizLinkOffer.find({ contact: o.contact, user: { $ne: oid(key) }, status: { $in: ["pending", "unlinked"] } }).lean<Offer[]>())
    await withdraw(x, "linkedElsewhere");
  return { status: "linked" as const, already: o.status === "linked" };
};

// «این من نیستم»: never offered again; the centre is told the number may be
// wrong (nothing else about the user)
export const declineOffer = async (user: { _id: unknown }, offerId: string, meta: Meta) => {
  const o = await myOffer(user._id, offerId);
  if (o.status === "declined") return { status: "declined" as const, already: true };
  if (o.status !== "pending") throw new AppError("این پیشنهاد دیگر معتبر نیست", 409);
  const done = await BizLinkOffer.findOneAndUpdate(
    { _id: o._id, status: "pending" },
    { $set: { status: "declined", declinedAt: new Date() }, $unset: { snoozedUntil: 1 } },
    { new: true },
  ).lean<Offer>();
  if (!done) return { status: "declined" as const, already: true };
  const owner = ownerOfDoc(o);
  const [name, info, c] = await Promise.all([
    nameOf(owner),
    orgInfo(owner).catch(() => null),
    BizContact.findById(o.contact).select("name phone").lean<IBizContact>(),
  ]);
  await logOffer(done, "declined", name, { actor: "patient" }, meta);
  if (info?.user)
    await notify(
      info.user,
      "شماره‌ی یک بیمار احتمالاً اشتباه است",
      `دارنده‌ی شماره‌ی پرونده‌ی «${c?.name || c?.phone || ""}» در نویان گفته است که بیمار شما نیست؛ شماره را بررسی کنید`,
      crmLink(owner, `contacts/${o.contact}`),
    );
  return { status: "declined" as const, already: false };
};

// «بعداً»: asked again in a week
export const snoozeOffer = async (user: { _id: unknown }, offerId: string, meta: Meta) => {
  const o = await myOffer(user._id, offerId);
  if (o.status !== "pending") throw new AppError("این پیشنهاد دیگر معتبر نیست", 409);
  const done = await BizLinkOffer.findOneAndUpdate(
    { _id: o._id, status: "pending" },
    { $set: { snoozedUntil: new Date(Date.now() + SNOOZE_DAYS * DAY) } },
    { new: true },
  ).lean<Offer>();
  if (done) await logOffer(done, "dismissed-later", await nameOf(ownerOfDoc(o)), { actor: "patient" }, meta);
  return { status: "pending" as const, snoozedUntil: done?.snoozedUntil };
};

// The patient takes a link back. The centre keeps its contact (and its own
// visit figures); only the tie to the account goes. Works for visit-made
// links too: the visit sync then leaves the contact unlinked.
export const unlinkContact = async (user: { _id: unknown }, contactId: string, meta: Meta) => {
  if (!isId(contactId)) throw new NotFoundError();
  const uid = oid(user._id);
  const c = await BizContact.findOneAndUpdate({ _id: contactId, user: uid }, { $unset: { user: 1 } }, { new: false }).lean<IBizContact>();
  if (!c) {
    if (await BizLinkOffer.exists({ contact: contactId, user: uid, status: "unlinked" })) return { status: "unlinked" as const, already: true };
    throw new NotFoundError();
  }
  const now = new Date();
  const o = await BizLinkOffer.findOneAndUpdate(
    { contact: c._id, user: uid },
    {
      $set: { status: "unlinked", unlinkedAt: now },
      $unset: { snoozedUntil: 1 },
      $setOnInsert: { ownerKind: c.ownerKind, ownerId: c.ownerId, phone: c.phone, source: sourceOf(c), offeredAt: c.firstSeenAt || c.createdAt || now },
    },
    { upsert: true, new: true },
  ).lean<Offer>();
  if (o) await logOffer(o, "unlinked", await nameOf(ownerOfDoc(c)), { actor: "patient" }, meta);
  return { status: "unlinked" as const, already: false };
};

// the patient's linked records (and those they unlinked, to link again)
export const linksOf = async (userId: unknown) => {
  const uid = oid(userId);
  const [contacts, offers] = await Promise.all([
    BizContact.find({ user: uid, isActive: { $ne: false } }).select("ownerKind ownerId source via firstSeenAt createdAt").lean<IBizContact[]>(),
    BizLinkOffer.find({ user: uid, status: { $in: ["linked", "unlinked"] } }).lean<Offer[]>(),
  ]);
  const byContact = new Map(offers.map((o) => [String(o.contact), o]));
  const out: {
    contact: string;
    offer?: string;
    ownerKind: string;
    ownerId: string;
    centre: string;
    status: "linked" | "unlinked";
    source: BizLinkSource;
    since?: Date;
  }[] = [];
  for (const c of contacts) {
    const o = byContact.get(String(c._id));
    out.push({
      contact: String(c._id),
      ...(o ? { offer: String(o._id) } : {}),
      ownerKind: c.ownerKind,
      ownerId: String(c.ownerId),
      centre: await nameOf(ownerOfDoc(c)),
      status: "linked",
      source: o?.source || sourceOf(c),
      since: o?.linkedAt || c.firstSeenAt || c.createdAt,
    });
  }
  for (const o of offers.filter((x) => x.status === "unlinked"))
    out.push({
      contact: String(o.contact),
      offer: String(o._id),
      ownerKind: o.ownerKind,
      ownerId: String(o.ownerId),
      centre: await nameOf(ownerOfDoc(o)),
      status: "unlinked",
      source: o.source,
      since: o.unlinkedAt,
    });
  return out.filter((r) => r.centre);
};

// the patient's own consent history (phone masked)
export const historyOf = async (userId: unknown) => {
  const rows = await BizConsentLog.find({ user: oid(userId) }).sort({ at: -1 }).limit(200).lean<IBizConsentLog[]>();
  return rows.map((r) => ({
    _id: r._id,
    at: r.at,
    action: r.action,
    actor: r.actor,
    source: r.source,
    centre: r.ownerName || "",
    ownerKind: r.ownerKind,
    phone: maskPhone(r.phone),
  }));
};

// what the centre sees on a contact: linked / offer pending / declined /
// unlinked, with dates. No user details beyond "a verified Noyan user".
export const linkStateOf = async (contact: Pick<IBizContact, "_id" | "user" | "source" | "via" | "firstSeenAt" | "createdAt">) => {
  const offers = await BizLinkOffer.find({ contact: contact._id }).sort({ updatedAt: -1 }).lean<Offer[]>();
  const live = contact.user ? offers.find((o) => String(o.user) === String(contact.user)) : undefined;
  const pick = (s: string) => offers.find((o) => o.status === s);
  const o = live || pick("pending") || pick("declined") || pick("unlinked");
  const status: "linked" | "pending" | "declined" | "unlinked" | "none" = contact.user ? "linked" : o ? (o.status as "pending" | "declined" | "unlinked") : "none";
  return {
    status,
    verified: !!contact.user,
    source: o?.source || sourceOf(contact),
    offeredAt: o?.offeredAt,
    linkedAt: contact.user ? o?.linkedAt || contact.firstSeenAt || contact.createdAt : o?.linkedAt,
    declinedAt: o?.declinedAt,
    unlinkedAt: o?.unlinkedAt,
    wrongNumber: !contact.user && !!pick("declined"),
  };
};

// The visit sync tied these contacts to the users who booked or bought
// there: logged as source "visit" (no prompt - the patient came on Noyan).
export const logVisitLinks = async (
  owner: BizOwner,
  before: Map<string, string | null>,
  phones: Map<string, string>,
) => {
  if (!phones.size) return;
  const contacts = await BizContact.find({ ownerKind: owner.kind, ownerId: oid(owner.id), phone: { $in: [...phones.keys()] } })
    .select("phone user")
    .lean<IBizContact[]>();
  const fresh = contacts.filter((c) => c.user && phones.get(c.phone) === String(c.user) && before.get(c.phone) !== String(c.user));
  if (!fresh.length) return;
  const name = await nameOf(owner);
  await writeLog(
    fresh.map((c) => ({
      user: c.user,
      contact: c._id,
      ownerKind: owner.kind,
      ownerId: oid(owner.id),
      ownerName: name,
      action: "linked" as const,
      actor: "system" as const,
      source: "visit" as const,
      phone: c.phone,
    })),
  );
  // an open offer of the same pair is settled by the visit; one to anyone
  // else is withdrawn (a contact linked to A is never offered to B)
  for (const c of fresh) {
    await BizLinkOffer.updateMany(
      { contact: c._id, user: c.user, status: "pending" },
      { $set: { status: "linked", linkedAt: new Date() }, $unset: { snoozedUntil: 1 } },
    );
    const others = await BizLinkOffer.find({ contact: c._id, user: { $ne: c.user }, status: "pending" }).lean<Offer[]>();
    for (const o of others) await withdraw(o, "linkedElsewhere");
  }
};

// phones (09…) whose contact of this owner the user has unlinked: the visit
// sync must not tie them back
export const unlinkedPairs = async (owner: BizOwner) => {
  const rows = await BizLinkOffer.find({ ownerKind: owner.kind, ownerId: oid(owner.id), status: "unlinked" })
    .select("user contact")
    .lean<{ user: mongoose.Types.ObjectId; contact: mongoose.Types.ObjectId }[]>();
  return new Set(rows.map((r) => `${r.contact}:${r.user}`));
};
