import { tehranParts } from "../tehranTime";
import mongoose from "mongoose";
import crypto from "crypto";
import moment from "moment-jalaali";
import BizContact, { IBizContact } from "../../Models/BizContact";
import BizActivity from "../../Models/BizActivity";
import { IBizAudience } from "../../Models/BizCampaign";
import SmsOptOut from "../../Models/SmsOptOut";
import Reservation from "../../Models/Reservation";
import Order from "../../Models/Order";
import Office from "../../Models/Office";
import ProductSeller from "../../Models/ProductSeller";
import ProductPackage from "../../Models/ProductPackage";
import ParaClinicTest from "../../Models/ParaClinicTest";
import Service from "../../Models/Service";
import ServicePackage from "../../Models/ServicePackage";
import User from "../../Models/User";
import UserIdentity from "../../Models/UserIdentity";
import UserAddress from "../../Models/UserAddress";
import BizSegment, { IBizRules } from "../../Models/BizSegment";
import BizMessage from "../../Models/BizMessage";
import Insurance from "../../Models/Insurance";
import { insurerKindOf } from "../insuranceTariffs";
import { BizOwner } from "./coa";
import { logVisitLinks, unlinkedPairs } from "./crmService/link";
import { translateNotificationText } from "../i18n/translateNotification";
import { currentLocale } from "../i18n/requestContext";

// Noyan Business CRM (2026-10, docs/business-suite.md phase 4), after
// nexxacrm's contacts and activities: each owner's patients and customers
// are the people who booked with it or bought from it on Noyan - the list
// builds itself from the owner's own visits and orders, so nobody types a
// patient in twice, and it is the consent base a campaign SMS may reach.

const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
export const own = (o: BizOwner) => ({ ownerKind: o.kind, ownerId: oid(o.id) });
const DAY = 864e5;

// 09xxxxxxxxx from any common way of writing an Iranian mobile (nexxacrm
// normalizeIranMobile), Persian and Arabic digits included
export const normalizeMobile = (raw?: string | null): string | null => {
  if (!raw) return null;
  let n = String(raw)
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[^\d+]/g, "");
  if (n.startsWith("+98")) n = "0" + n.slice(3);
  else if (n.startsWith("0098")) n = "0" + n.slice(4);
  else if (n.startsWith("98") && n.length === 12) n = "0" + n.slice(2);
  if (/^9\d{9}$/.test(n)) n = "0" + n;
  return /^09\d{9}$/.test(n) ? n : null;
};

export const newOptCode = () => crypto.randomBytes(6).toString("base64url").slice(0, 8);

type Seen = {
  user: string;
  visits: number;
  orders: number;
  spent: number;
  first: Date;
  last: Date;
  identity?: unknown;
  noShows?: number;
  lastNoShow?: Date | null;
  lastVisit?: Date | null;
  lastSessionType?: string | null;
};

const later = (a?: Date | null, b?: Date | null) => (!a ? b ?? null : !b ? a : a > b ? a : b);

// the Jalali month*100+day of a date (Tehran), for birthdays
export const jalaliMD = (d: Date | string) => {
  const m = moment(new Date(d)).utcOffset(210);
  return (m.jMonth() + 1) * 100 + m.jDate();
};

const merge = (into: Map<string, Seen>, rows: Seen[]) => {
  for (const r of rows) {
    const k = String(r.user);
    const p = into.get(k);
    if (!p) into.set(k, { ...r, user: k });
    else
      into.set(k, {
        user: k,
        visits: p.visits + r.visits,
        orders: p.orders + r.orders,
        spent: p.spent + r.spent,
        first: p.first < r.first ? p.first : r.first,
        last: p.last > r.last ? p.last : r.last,
        identity: r.last > p.last ? r.identity ?? p.identity : p.identity ?? r.identity,
        noShows: (p.noShows || 0) + (r.noShows || 0),
        lastNoShow: later(p.lastNoShow, r.lastNoShow),
        lastVisit: later(p.lastVisit, r.lastVisit),
        lastSessionType: (r.lastVisit && (!p.lastVisit || r.lastVisit > p.lastVisit) ? r.lastSessionType : p.lastSessionType) ?? null,
      });
  }
};

// visits: booked and not cancelled
export const visitsWhere = async (owner: BizOwner): Promise<Record<string, unknown> | null> => {
  if (owner.kind === "doctor") return { doctor: oid(owner.id) };
  if (owner.kind === "clinic" || owner.kind === "hospital") {
    const offices = await Office.find({ [owner.kind]: oid(owner.id) }).select("_id").lean();
    return offices.length ? { office: { $in: offices.map((o) => o._id) } } : null;
  }
  return null;
};

// An insurer's members (2026-10): the patients whose visits were claimed
// from it - an insurer line of this insurer that was booked into the
// provider's books (Models/Reservation.ts insurerLineStatuses). The insurer
// already receives these people in its claim lists, so they are its
// relationship base the way a visit is a doctor's; a patient who only saved
// the insurer in «بیمه‌های من» is not handed to it.
export const memberVisitsWhere = (owner: BizOwner): Record<string, unknown> | null =>
  owner.kind === "insurance" && owner.id ? { "insuranceQuote.lines": { $elemMatch: { insurance: oid(owner.id), status: "booked" } } } : null;

// the visits a contact's figures and timeline are read from: the owner's own
// visits, or an insurer's covered visits
const contactVisitsWhere = async (owner: BizOwner) => memberVisitsWhere(owner) || (await visitsWhere(owner));

const visitRows = async (owner: BizOwner): Promise<Seen[]> => {
  const where = await contactVisitsWhere(owner);
  if (!where) return [];
  // visits: attended (active / completed); a no-show of the patient's own is
  // counted apart (it still paid)
  const attended = { $in: ["$status", ["active", "completed"]] };
  const missed = { $and: [{ $eq: ["$status", "noShow"] }, { $ne: ["$noShowParty", "doctor"] }] };
  // what the patient spent with this owner; for an insurer, what it paid
  // for the member (its booked lines' shares)
  const paid =
    owner.kind === "insurance"
      ? {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: { $ifNull: ["$insuranceQuote.lines", []] },
                  as: "l",
                  cond: { $and: [{ $eq: ["$$l.insurance", oid(owner.id)] }, { $eq: ["$$l.status", "booked"] }] },
                },
              },
              as: "l",
              in: { $ifNull: ["$$l.share", 0] },
            },
          },
        }
      : { $ifNull: ["$total", 0] };
  return Reservation.aggregate([
    { $match: { ...where, status: { $in: ["active", "completed", "noShow"] }, user: { $exists: true } } },
    { $sort: { date: 1 } },
    {
      $group: {
        _id: "$user",
        visits: { $sum: { $cond: [attended, 1, 0] } },
        noShows: { $sum: { $cond: [missed, 1, 0] } },
        spent: { $sum: paid },
        first: { $min: "$date" },
        last: { $max: "$date" },
        lastVisit: { $max: { $cond: [attended, "$date", null] } },
        lastNoShow: { $max: { $cond: [missed, "$date", null] } },
        lastSessionType: { $last: "$sessionType" },
        identity: { $last: "$patient" },
      },
    },
    {
      $project: {
        user: "$_id",
        visits: 1,
        noShows: 1,
        orders: { $literal: 0 },
        spent: 1,
        first: 1,
        last: 1,
        lastVisit: 1,
        lastNoShow: 1,
        lastSessionType: 1,
        identity: 1,
      },
    },
  ]);
};

// the order lines that are this owner's: [array field, item ids]
export const orderLines = async (owner: BizOwner): Promise<[string, mongoose.Types.ObjectId[]][]> => {
  const id = oid(owner.id);
  const ids = async (model: mongoose.Model<any>, field: string) =>
    (await model.find({ [field]: id }).select("_id").lean<{ _id: mongoose.Types.ObjectId }[]>()).map((d) => d._id);
  if (owner.kind === "pharmacy")
    return [
      ["products", await ids(ProductSeller, "seller")],
      ["productPackages", await ids(ProductPackage, "owner")],
    ];
  if (owner.kind === "paraClinic") return [["tests", await ids(ParaClinicTest, "paraClinic")]];
  if (owner.kind === "doctor")
    return [
      ["services", await ids(Service, "owner")],
      ["servicePackages", await ids(ServicePackage, "owner")],
    ];
  return [];
};

const orderRows = async (owner: BizOwner): Promise<Seen[]> => {
  const lines = (await orderLines(owner)).filter(([, ids]) => ids.length);
  if (!lines.length) return [];
  const out = new Map<string, Seen>();
  for (const [field, ids] of lines) {
    const rows: Seen[] = await Order.aggregate([
      { $match: { status: "paid", [`${field}.item`]: { $in: ids } } },
      {
        $project: {
          user: 1,
          at: { $ifNull: ["$paidAt", "$submittedAt"] },
          spent: {
            $sum: {
              $map: {
                input: { $filter: { input: `$${field}`, as: "l", cond: { $in: ["$$l.item", ids] } } },
                as: "l",
                in: { $multiply: [{ $ifNull: ["$$l.price", 0] }, { $ifNull: ["$$l.qty", 1] }] },
              },
            },
          },
        },
      },
      { $group: { _id: "$user", orders: { $sum: 1 }, spent: { $sum: "$spent" }, first: { $min: "$at" }, last: { $max: "$at" } } },
      { $project: { user: "$_id", visits: { $literal: 0 }, orders: 1, spent: 1, first: 1, last: 1 } },
    ]);
    merge(out, rows);
  }
  return [...out.values()];
};

// at most every ten minutes per owner: the page opens often, the history
// changes slowly
const lastSync = new Map<string, number>();

export const syncContacts = async (owner: BizOwner, force = false) => {
  const key = `${owner.kind}:${owner.id}`;
  if (!force && Date.now() - (lastSync.get(key) || 0) < 10 * 60 * 1000) return;
  lastSync.set(key, Date.now());
  const seen = new Map<string, Seen>();
  merge(seen, await visitRows(owner));
  merge(seen, await orderRows(owner));
  if (!seen.size) return;
  const users = await User.find({ _id: { $in: [...seen.keys()] } }).select("phone").lean<{ _id: unknown; phone?: string }[]>();
  const identityIds = [...seen.values()].map((s) => s.identity).filter(Boolean);
  type Idn = {
    _id: unknown;
    user?: unknown;
    givenName?: string;
    lastName?: string;
    gender?: string;
    dateOfbirth?: Date;
    insurances?: { insurance?: unknown; expiresAt?: Date | null }[];
  };
  const identities = await UserIdentity.find({
    $or: [{ _id: { $in: identityIds } }, { user: { $in: users.map((u) => u._id) } }],
  })
    .select("user givenName lastName gender dateOfbirth insurances")
    .lean<Idn[]>();
  const byId = new Map(identities.map((i) => [String(i._id), i]));
  const byUser = new Map(identities.map((i) => [String(i.user), i]));
  // the basic insurer each patient saved on Noyan, as the contact's insurer
  // kind (only where the owner left it empty)
  const insIds = [...new Set(identities.flatMap((i) => (i.insurances || []).map((x) => String(x.insurance || ""))).filter((x) => mongoose.isValidObjectId(x)))];
  const insKind = new Map(
    (insIds.length ? await Insurance.find({ _id: { $in: insIds } }).select("name isBasic").lean<{ _id: unknown; name?: string; isBasic?: boolean }[]>() : []).map(
      (i) => [String(i._id), insurerKindOf(i)],
    ),
  );
  const basicOf = (idn?: Idn) => {
    for (const x of idn?.insurances || []) {
      const k = insKind.get(String(x.insurance));
      if (k && k !== "supplementary") return k as IBizContact["insurer"];
    }
    return undefined;
  };
  // an insurer's member: the card's last day with this insurer
  const memberUntilOf = (idn?: Idn) =>
    owner.kind === "insurance" ? (idn?.insurances || []).find((x) => String(x.insurance) === String(owner.id))?.expiresAt || undefined : undefined;
  // the city of each patient's latest address with one
  const addresses = await UserAddress.find({ user: { $in: users.map((u) => u._id) }, city: { $exists: true } })
    .sort({ _id: -1 })
    .select("user city")
    .populate("city", "name")
    .lean<{ user: unknown; city?: { name?: string } }[]>()
    .catch(() => []);
  const cityOf = new Map<string, string>();
  for (const a of addresses) if (a.city?.name && !cityOf.has(String(a.user))) cityOf.set(String(a.user), a.city.name);
  const ops: mongoose.AnyBulkWriteOperation[] = [];
  // record linking (Lib/business/crmService/link.ts): who each phone's
  // contact was tied to before, and the contacts a patient unlinked
  // themselves (their visits still count; the tie is not made again)
  const phonesOf = users.map((u) => normalizeMobile(u.phone)).filter((p): p is string => !!p);
  const prior = await BizContact.find({ ...own(owner), phone: { $in: phonesOf } }).select("phone user insurer").lean<IBizContact[]>();
  const before = new Map(prior.map((c) => [c.phone, c.user ? String(c.user) : null]));
  const hasInsurer = new Set(prior.filter((c) => c.insurer).map((c) => c.phone));
  const contactIdOf = new Map(prior.map((c) => [c.phone, String(c._id)]));
  const unlinked = await unlinkedPairs(owner);
  const tied = new Map<string, string>();
  for (const u of users) {
    const s = seen.get(String(u._id))!;
    const phone = normalizeMobile(u.phone);
    if (!phone) continue;
    const keepOff = contactIdOf.has(phone) && unlinked.has(`${contactIdOf.get(phone)}:${u._id}`);
    if (!keepOff) tied.set(phone, String(u._id));
    // the account holder's own identity first: the booking may be for a child
    const idn = byUser.get(String(u._id)) || byId.get(String(s.identity));
    const name = idn ? `${idn.givenName || ""} ${idn.lastName || ""}`.trim() : "";
    const insurer = hasInsurer.has(phone) ? undefined : basicOf(idn);
    const memberUntil = memberUntilOf(byUser.get(String(u._id))) || memberUntilOf(byId.get(String(s.identity)));
    ops.push({
      updateOne: {
        filter: { ...own(owner), phone },
        update: {
          $set: {
            updatedAt: new Date(),
            ...(keepOff ? {} : { user: u._id }),
            visits: s.visits,
            orders: s.orders,
            spent: Math.round(s.spent),
            firstSeenAt: s.first,
            lastSeenAt: s.last,
            noShows: s.noShows || 0,
            ...(s.lastNoShow ? { lastNoShowAt: s.lastNoShow } : {}),
            ...(s.lastVisit ? { lastVisitAt: s.lastVisit } : {}),
            ...(s.lastSessionType ? { lastSessionType: s.lastSessionType } : {}),
            ...(name ? { name } : {}),
            ...(cityOf.get(String(u._id)) ? { city: cityOf.get(String(u._id)) } : {}),
            ...(insurer ? { insurer } : {}),
            ...(memberUntil ? { memberUntil: new Date(memberUntil) } : {}),
            ...(idn?.gender === "male" || idn?.gender === "female" ? { gender: idn.gender } : {}),
            ...(idn?.dateOfbirth
              ? {
                  birthYear: tehranParts(idn.dateOfbirth).year,
                  birthDate: new Date(idn.dateOfbirth),
                  birthMD: jalaliMD(idn.dateOfbirth),
                }
              : {}),
          },
          $setOnInsert: {
            createdAt: new Date(),
            source: owner.kind === "insurance" ? "member" : s.visits || s.noShows ? "visit" : "order",
            consentAt: s.first,
            optCode: newOptCode(),
            tags: [],
            smsOptOut: false,
            isActive: true,
          },
        },
        upsert: true,
      },
    });
  }
  if (ops.length) await BizContact.collection.bulkWrite(ops as never, { ordered: false }).catch((err) => console.log("[crm] sync failed:", err));
  await logVisitLinks(owner, before, tied).catch((err) => console.log("[crm] link log failed:", err));
  await mirrorGlobalOptOuts(owner).catch((err) => console.log("[crm] opt-out mirror failed:", err));
};

// A phone that left every Noyan campaign (Models/SmsOptOut.ts, the opt-out
// link's "all") is opted out on each owner's list too, so the list's badge,
// the segment counts and every sender agree; the patient's own wish, so the
// owner cannot switch it back (no ownerOptOutAt).
export const mirrorGlobalOptOuts = async (owner: BizOwner) => {
  const phones = (await BizContact.find({ ...own(owner), smsOptOut: { $ne: true } }).select("phone").lean<IBizContact[]>()).map((c) => c.phone);
  if (!phones.length) return;
  const out: string[] = [];
  for (let i = 0; i < phones.length; i += 5000) out.push(...(await SmsOptOut.distinct("phone", { phone: { $in: phones.slice(i, i + 5000) } })).map(String));
  if (out.length) await BizContact.updateMany({ ...own(owner), phone: { $in: out }, smsOptOut: { $ne: true } }, { $set: { smsOptOut: true, optOutAt: new Date() } });
};

// ---------------------------------------------------------------- rules

// The Mongo filter of one set of contact rules (Models/BizSegment.ts), on
// this owner's contacts only. "high value" is the top fifth by spending,
// worked out now; birthdays are Jalali (Tehran).
export const rulesFilter = async (owner: BizOwner, r: Partial<IBizRules>) => {
  const and: Record<string, unknown>[] = [own(owner)];
  const now = Date.now();
  if (r.tags?.length) and.push({ tags: r.tagsAll ? { $all: r.tags } : { $in: r.tags } });
  if (r.excludeTags?.length) and.push({ tags: { $nin: r.excludeTags } });
  if (r.sources?.length) and.push({ source: { $in: r.sources } });
  if (r.gender) and.push({ gender: r.gender });
  const year = tehranParts().year;
  if (r.ageMin) and.push({ birthYear: { $lte: year - r.ageMin } });
  if (r.ageMax) and.push({ birthYear: { $gte: year - r.ageMax } });
  if (r.city) and.push({ city: { $regex: r.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } });
  if (r.insurer) and.push({ insurer: r.insurer });
  if (r.inactiveDays) and.push({ lastSeenAt: { $lte: new Date(now - r.inactiveDays * DAY) } });
  if (r.activeDays) and.push({ lastSeenAt: { $gte: new Date(now - r.activeDays * DAY) } });
  if (r.minVisits) and.push({ $expr: { $gte: [{ $add: ["$visits", "$orders"] }, r.minVisits] } });
  if (r.maxVisits !== undefined && r.maxVisits !== null && r.maxVisits >= 0 && Number.isFinite(r.maxVisits) && r.maxVisits < 10000)
    and.push({ $expr: { $lte: [{ $add: ["$visits", "$orders"] }, r.maxVisits] } });
  if (r.minSpent) and.push({ spent: { $gte: r.minSpent } });
  if (r.noShowDays) and.push({ lastNoShowAt: { $gte: new Date(now - r.noShowDays * DAY) } });
  if (r.newDays) and.push({ createdAt: { $gte: new Date(now - r.newDays * DAY) } });
  if (r.birthday) {
    const today = moment().utcOffset(210);
    if (r.birthday === "month") {
      const m = today.jMonth() + 1;
      and.push({ birthMD: { $gte: m * 100 + 1, $lte: m * 100 + 31 } });
    } else {
      const days = r.birthday === "today" ? 1 : 7;
      const mds = Array.from({ length: days }, (_, i) => {
        const d = today.clone().add(i, "day");
        return (d.jMonth() + 1) * 100 + d.jDate();
      });
      and.push({ birthMD: { $in: mds } });
    }
  }
  if (r.highValue) {
    const total = await BizContact.countDocuments({ ...own(owner), spent: { $gt: 0 } });
    const cut = total
      ? await BizContact.find({ ...own(owner), spent: { $gt: 0 } })
          .sort({ spent: -1 })
          .skip(Math.max(0, Math.ceil(total / 5) - 1))
          .limit(1)
          .select("spent")
          .lean<{ spent: number }[]>()
      : [];
    and.push({ spent: { $gte: Math.max(1, cut[0]?.spent || 1) } });
  }
  return { $and: and };
};

// Ready-made segments every owner has (not stored): the filter and the
// text key the panel names it by.
export const presetSegments: Record<string, Partial<IBizRules>> = {
  lapsed: { inactiveDays: 180 },
  recent: { activeDays: 30 },
  loyal: { minVisits: 3 },
  highValue: { highValue: true },
  birthdayWeek: { birthday: "week" },
  birthdayMonth: { birthday: "month" },
  noShow90: { noShowDays: 90 },
  newMonth: { newDays: 30 },
};

// the rules behind an audience: a saved segment (read now), else its own
export const resolveRules = async (owner: BizOwner, a: Partial<IBizAudience> & { segment?: unknown }) => {
  if (a.segment && mongoose.isValidObjectId(String(a.segment))) {
    const seg = await BizSegment.findOne({ ...own(owner), _id: a.segment }).lean();
    if (seg) return (seg.rules || {}) as Partial<IBizRules>;
  }
  return a as Partial<IBizRules>;
};

// ---------------------------------------------------------------- audience

// The contacts a campaign with this audience reaches: active, with a mobile,
// not opted out of this owner or of all Noyan campaigns; a hand-picked
// selection, or the rules (of a saved segment or its own).
export const audienceFilter = async (owner: BizOwner, a: Partial<IBizAudience>) => {
  const base = { ...own(owner), isActive: true, smsOptOut: { $ne: true } };
  if (a.contactIds?.length) return { ...base, _id: { $in: a.contactIds.map(oid) } };
  return { $and: [base, await rulesFilter(owner, await resolveRules(owner, a))] };
};

export const audienceContacts = async (owner: BizOwner, a: Partial<IBizAudience>) => {
  const rows = await BizContact.find(await audienceFilter(owner, a))
    .select("phone name optCode user lastVisitAt")
    .lean<IBizContact[]>();
  if (!rows.length) return rows;
  const out = new Set(
    (await SmsOptOut.find({ phone: { $in: rows.map((r) => r.phone) } }).select("phone").lean()).map((o) => o.phone),
  );
  return rows.filter((r) => !out.has(r.phone));
};

// ---------------------------------------------------------------- timeline

// One contact's history: its visits and orders with this owner (read from
// their own records) and the notes, calls and follow-ups written here.
export const contactTimeline = async (owner: BizOwner, contact: IBizContact) => {
  const items: {
    kind: string;
    at: Date;
    text?: string;
    status?: string;
    id?: string;
    dueAt?: Date;
    doneAt?: Date;
    amount?: number;
    sessionType?: string;
    source?: string;
    clicks?: number;
  }[] = [];
  if (contact.user) {
    const where = await contactVisitsWhere(owner);
    if (where) {
      const rs = await Reservation.find({ ...where, user: contact.user })
        .sort({ date: -1 })
        .limit(30)
        .select("date status total sessionType")
        .lean<{ _id: unknown; date: Date; status: string; total?: number; sessionType?: string }[]>();
      for (const r of rs)
        items.push({ kind: "visit", at: r.date, status: r.status, id: String(r._id), amount: r.total || 0, sessionType: r.sessionType });
    }
    const lines = (await orderLines(owner)).filter(([, ids]) => ids.length);
    if (lines.length) {
      const os = await Order.find({ user: contact.user, $or: lines.map(([f, ids]) => ({ [`${f}.item`]: { $in: ids } })) })
        .sort({ _id: -1 })
        .limit(30)
        .select("status paidAt submittedAt createdAt")
        .lean<{ _id: unknown; status: string; paidAt?: Date; submittedAt?: Date; createdAt?: Date }[]>();
      for (const o of os)
        items.push({ kind: "order", at: o.paidAt || o.submittedAt || o.createdAt || new Date(), status: o.status, id: String(o._id) });
    }
  }
  const [acts, msgs] = await Promise.all([
    BizActivity.find({ ...own(owner), contact: contact._id }).sort({ createdAt: -1 }).limit(100).lean(),
    BizMessage.find({ ...own(owner), contact: contact._id }).sort({ createdAt: -1 }).limit(50).select("text status source clicks sentAt createdAt").lean(),
  ]);
  // the notes Noyan writes itself (a plan made, a contract signed, a refill
  // call) are stored in Persian and read in the viewer's language, like
  // notifications (Lib/i18n/notificationMessages.ts); the team's own text
  // comes back as written
  const loc = currentLocale();
  for (const a of acts)
    items.push({ kind: a.kind, at: a.createdAt, text: translateNotificationText(a.text, loc), id: String(a._id), dueAt: a.dueAt, doneAt: a.doneAt });
  for (const m of msgs)
    items.push({ kind: "sms", at: m.sentAt || m.createdAt, text: m.text, status: m.status, id: String(m._id), source: m.source, clicks: m.clicks });
  return items.sort((x, y) => +new Date(y.at) - +new Date(x.at));
};
