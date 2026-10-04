import mongoose from "mongoose";
import moment from "moment-jalaali";
import BizAutomation, { BizAutomationKind, IBizAutomation } from "../../Models/BizAutomation";
import BizTemplate, { IBizTemplate } from "../../Models/BizTemplate";
import BizContact, { IBizContact } from "../../Models/BizContact";
import BizMessage from "../../Models/BizMessage";
import BizActivity from "../../Models/BizActivity";
import SmsOptOut from "../../Models/SmsOptOut";
import Reservation from "../../Models/Reservation";
import Wallet from "../../Models/Wallet";
import Notification from "../../Models/Notification";
import { BizOwner } from "./coa";
import { own, rulesFilter, syncContacts, visitsWhere } from "./crm";
import {
  giveQuota,
  inOwnWindow,
  monthlyQuota,
  orgInfo,
  ownerModules,
  takeQuota,
  unitPrice,
  varsFor,
  walletTx,
} from "./campaign";
import { attributeBookings, messageFor, newTrackedLink, orgPublicUrl, randomCode, renderText, sendOne, siteBase, smsParts, trackedUrl } from "./crmSend";

// CRM automations (2026-10, Models/BizAutomation.ts): the rule-based patient
// journeys, after Doctolib's recalls, Practo Ray's Engage and Docplanner's
// post-visit messages. A job runs every five minutes; for each switched-on
// automation it finds the events due now (a visit N days ago, a missed
// visit, a birthday, a patient lapsing), keeps the contacts who match the
// audience, have not opted out and had no automated SMS from this owner in
// the last `gapDays`, records each message under a unique key and sends it.
// Only events that fall due after the automation was switched on are sent:
// turning it on never blasts the whole history.

const DAY = 864e5;
const HOUR = 36e5;
const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
const ownerOf = (a: { ownerKind: string; ownerId: unknown }) => ({ kind: a.ownerKind, id: String(a.ownerId) }) as BizOwner;

// the defaults a new automation of each kind starts from
export const automationDefaults: Record<BizAutomationKind, { delay: number; unit: "days" | "hours"; gapDays: number; oncePerYear: boolean }> = {
  recall: { delay: 180, unit: "days", gapDays: 3, oncePerYear: false },
  thanks: { delay: 3, unit: "hours", gapDays: 0, oncePerYear: false },
  birthday: { delay: 0, unit: "days", gapDays: 1, oncePerYear: true },
  noShow: { delay: 24, unit: "hours", gapDays: 1, oncePerYear: false },
  winback: { delay: 365, unit: "days", gapDays: 7, oncePerYear: true },
  chronic: { delay: 90, unit: "days", gapDays: 3, oncePerYear: false },
};
const delayMs = (a: Pick<IBizAutomation, "kind" | "delay">) => a.delay * (automationDefaults[a.kind].unit === "hours" ? HOUR : DAY);

export type Candidate = { contact: IBizContact; key: string; reservation?: unknown; target?: string; dueAt: Date };

const dayKey = (d?: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

// has the patient booked again (anything not cancelled) after this moment?
const bookedSince = async (where: Record<string, unknown>, users: unknown[], since: Map<string, Date>) => {
  if (!users.length) return new Set<string>();
  const rows = await Reservation.aggregate([
    { $match: { ...where, user: { $in: users.map(oid) }, status: { $ne: "cancelled" } } },
    { $group: { _id: "$user", last: { $max: "$date" } } },
  ]);
  return new Set(
    rows.filter((r: { _id: unknown; last: Date }) => r.last > (since.get(String(r._id)) || new Date(0))).map((r: { _id: unknown }) => String(r._id)),
  );
};

// The events of one automation due by `until` (now, or now + a horizon for
// the "coming up" counts), from `floor` on (the moment it was switched on).
const events = async (a: IBizAutomation, owner: BizOwner, until: number, floor: number, base: string): Promise<Candidate[]> => {
  const d = delayMs(a);
  const out: Candidate[] = [];
  const o = own(owner);
  const byUser = async (users: unknown[]) => {
    const cs = await BizContact.find({ ...o, user: { $in: users.map(oid) } }).lean<IBizContact[]>();
    return new Map(cs.map((c) => [String(c.user), c]));
  };
  if (a.kind === "recall" || a.kind === "thanks" || a.kind === "noShow") {
    const where = await visitsWhere(owner);
    if (!where) return out;
    const field = a.kind === "recall" ? "date" : "finalizedAt";
    const match: Record<string, unknown> = {
      ...where,
      user: { $exists: true },
      status: a.kind === "noShow" ? "noShow" : "completed",
      [field]: { $gte: new Date(floor - d), $lte: new Date(until - d) },
      ...(a.kind === "noShow" ? { noShowParty: { $ne: "doctor" } } : {}),
      ...(a.kind === "recall" && a.sessionTypes?.length ? { sessionType: { $in: a.sessionTypes } } : {}),
    };
    const rs = await Reservation.find(match)
      .sort({ [field]: 1 })
      .limit(1000)
      .select("user date finalizedAt")
      .lean<{ _id: unknown; user: unknown; date: Date; finalizedAt?: Date }[]>();
    if (!rs.length) return out;
    const contacts = await byUser(rs.map((r) => r.user));
    // a recall or a missed visit is moot once they booked again
    const since = new Map(rs.map((r) => [String(r.user), r.date]));
    const again = a.kind === "thanks" ? new Set<string>() : await bookedSince(where, rs.map((r) => r.user), since);
    for (const r of rs) {
      const c = contacts.get(String(r.user));
      if (!c || again.has(String(r.user))) continue;
      out.push({
        contact: c,
        key: `auto:${a._id}:res:${r._id}`,
        reservation: r._id,
        dueAt: new Date(+new Date((a.kind === "recall" ? r.date : r.finalizedAt) || r.date) + d),
        ...(a.kind === "thanks" ? { target: `${base}/dashboard/booking/${r._id}` } : {}),
      });
    }
    return out;
  }
  if (a.kind === "birthday") {
    const days = Math.max(1, Math.ceil((until - Date.now()) / DAY) + 1);
    const today = moment().utcOffset(210);
    for (let i = 0; i < Math.min(days, 8); i++) {
      const m = today.clone().add(i, "day");
      const md = (m.jMonth() + 1) * 100 + m.jDate();
      const cs = await BizContact.find({ ...o, birthMD: md }).limit(1000).lean<IBizContact[]>();
      for (const c of cs) out.push({ contact: c, key: `auto:${a._id}:bday:${c._id}:${m.jYear()}`, dueAt: m.toDate() });
    }
    return out;
  }
  // winback (no visit or order at all) / chronic (no visit, tagged)
  const field = a.kind === "winback" ? "lastSeenAt" : "lastVisitAt";
  if (a.kind === "chronic" && !a.audience?.tags?.length) return out;
  const cs = await BizContact.find({ ...o, [field]: { $gte: new Date(floor - d), $lte: new Date(until - d) } })
    .limit(1000)
    .lean<IBizContact[]>();
  const where = await visitsWhere(owner);
  const withUser = cs.filter((c) => c.user);
  const again = where
    ? await bookedSince(where, withUser.map((c) => c.user), new Map(withUser.map((c) => [String(c.user), (c as any)[field] as Date])))
    : new Set<string>();
  for (const c of cs) {
    if (c.user && again.has(String(c.user))) continue;
    const at = (c as any)[field] as Date;
    out.push({ contact: c, key: `auto:${a._id}:${a.kind}:${c._id}:${dayKey(at)}`, dueAt: new Date(+new Date(at) + d) });
  }
  return out;
};

// The events left once the audience, the opt-outs, the per-contact gap and
// the once-a-year rule are applied, and what was already sent is dropped.
export const dueCandidates = async (a: IBizAutomation, opts: { horizonMs?: number } = {}) => {
  const owner = ownerOf(a);
  const base = await siteBase();
  const now = Date.now();
  const floor = +(a.enabledAt || a.createdAt || new Date()) - DAY;
  let list = await events(a, owner, now + (opts.horizonMs || 0), floor, base);
  if (!list.length) return list;
  // one event per contact per run (the earliest)
  const seen = new Set<string>();
  list = list.filter((c) => (seen.has(String(c.contact._id)) ? false : (seen.add(String(c.contact._id)), true)));
  const ids = list.map((c) => c.contact._id);
  const [match, globalOut, done, recent, thisYear] = await Promise.all([
    BizContact.find({ $and: [{ _id: { $in: ids }, isActive: true, smsOptOut: { $ne: true } }, await rulesFilter(owner, a.audience || {})] })
      .select("_id")
      .lean(),
    SmsOptOut.find({ phone: { $in: list.map((c) => c.contact.phone) } }).select("phone").lean(),
    BizMessage.find({ dedupeKey: { $in: list.map((c) => c.key) } }).select("dedupeKey").lean(),
    a.gapDays
      ? BizMessage.find({ ...own(owner), contact: { $in: ids }, source: "automation", status: { $in: ["queued", "sent"] }, createdAt: { $gte: new Date(now - a.gapDays * DAY) } })
          .select("contact")
          .lean()
      : Promise.resolve([]),
    a.oncePerYear
      ? BizMessage.find({ automation: a._id, contact: { $in: ids }, status: { $in: ["queued", "sent"] }, createdAt: { $gte: new Date(now - 330 * DAY) } })
          .select("contact")
          .lean()
      : Promise.resolve([]),
  ]);
  const ok = new Set(match.map((m) => String(m._id)));
  const out = new Set(globalOut.map((g) => g.phone));
  const sent = new Set(done.map((m) => m.dedupeKey));
  const blocked = new Set([...recent, ...thisYear].map((m) => String(m.contact)));
  return list.filter((c) => ok.has(String(c.contact._id)) && !out.has(c.contact.phone) && !sent.has(c.key) && !blocked.has(String(c.contact._id)));
};

// ---------------------------------------------------------------- run

const MAX_PER_RUN = 200;

const runAutomation = async (a: IBizAutomation) => {
  const owner = ownerOf(a);
  const setError = (lastError: string) => BizAutomation.updateOne({ _id: a._id }, { $set: { lastRunAt: new Date(), lastError } });
  if (!inOwnWindow(a.windowFrom, a.windowUntil)) return;
  const modules = await ownerModules(owner).catch(() => [] as string[]);
  if (!modules.includes("crm")) return setError("module");
  const tpl = a.template ? await BizTemplate.findOne({ ...own(owner), _id: a.template }).lean<IBizTemplate>() : null;
  if (!tpl || tpl.status !== "Approved") return setError("template");
  await syncContacts(owner);
  const due = (await dueCandidates(a)).slice(0, MAX_PER_RUN);
  if (!due.length) return BizAutomation.updateOne({ _id: a._id }, { $set: { lastRunAt: new Date() }, $unset: { lastError: 1 } });
  const [info, base] = await Promise.all([orgInfo(owner), siteBase()]);
  const wantsLink = /\{(link|review)\}/.test(tpl.text);
  let token = "";
  if (wantsLink) {
    token = a.linkToken || (await newTrackedLink(await orgPublicUrl(owner, base)));
    if (token && !a.linkToken) await BizAutomation.updateOne({ _id: a._id }, { $set: { linkToken: token } });
  }
  const outgoing = due.map((c) => {
    const code = randomCode(6);
    const link = token ? trackedUrl(base, token, code) : "";
    const text = messageFor(renderText(tpl.text, varsFor(c.contact, info.name, link, link)), base, c.contact.optCode);
    return { ...c, code, text, parts: smsParts(text) };
  });
  // pay: the plan's quota first, then what the wallet covers; whoever does
  // not fit waits for the next run (nothing is recorded for them)
  const total = outgoing.reduce((n, o) => n + o.parts, 0);
  const price = await unitPrice();
  const fromQuota = await takeQuota(owner, total, await monthlyQuota(owner));
  const wallet = await Wallet.findOne({ user: info.user }).select("balance").lean<{ balance?: number }>();
  const affordable = price > 0 ? Math.floor((wallet?.balance || 0) / price) : Number.MAX_SAFE_INTEGER;
  let budget = fromQuota + Math.max(0, affordable);
  const chosen = outgoing.filter((o) => (o.parts <= budget ? ((budget -= o.parts), true) : false));
  const chosenParts = chosen.reduce((n, o) => n + o.parts, 0);
  let walletParts = Math.max(0, chosenParts - fromQuota);
  // the quota not needed (fewer fitted than asked) goes back now
  if (fromQuota > chosenParts) await giveQuota(owner, fromQuota - chosenParts);
  let quotaParts = Math.min(fromQuota, chosenParts);
  if (walletParts > 0) {
    const cost = walletParts * price;
    const debited = await Wallet.findOneAndUpdate({ user: info.user, balance: { $gte: cost } }, { $inc: { balance: -cost } });
    if (!debited) {
      await giveQuota(owner, quotaParts);
      return setError("noCredit");
    }
    await walletTx(owner, a._id, info.user, -cost, "smsAutomation");
  }
  let sent = 0;
  let failed = 0;
  let unsent = 0;
  for (const o of chosen) {
    const row = await BizMessage.create({
      ...own(owner),
      contact: o.contact._id,
      phone: o.contact.phone,
      source: "automation",
      automation: a._id,
      template: tpl._id,
      ...(o.reservation ? { reservation: o.reservation } : {}),
      dedupeKey: o.key,
      text: o.text,
      parts: o.parts,
      code: o.code,
      ...(o.target ? { target: o.target } : {}),
    }).catch(() => null);
    if (!row) {
      unsent += o.parts;
      continue;
    }
    const r = await sendOne(o.contact.phone, o.text);
    await BizMessage.updateOne(
      { _id: row._id },
      { $set: r.ok ? { status: "sent", sentAt: new Date(), outboxId: r.outboxId } : { status: "failed", reason: "gateway" } },
    );
    if (r.ok) sent++;
    else {
      failed++;
      unsent += o.parts;
    }
  }
  // what was not sent: the wallet's share back first, then the quota's
  const walletBack = Math.min(unsent, walletParts);
  if (walletBack > 0) {
    await Wallet.updateOne({ user: info.user }, { $inc: { balance: walletBack * price } });
    await walletTx(owner, a._id, info.user, walletBack * price, "smsAutomation");
    walletParts -= walletBack;
  }
  quotaParts = unsent - walletBack;
  await giveQuota(owner, quotaParts);
  await BizAutomation.updateOne(
    { _id: a._id },
    {
      $inc: { sentCount: sent, failedCount: failed, skippedCount: due.length - chosen.length },
      $set: { lastRunAt: new Date(), ...(chosen.length < due.length ? { lastError: "noCredit" } : {}) },
      ...(chosen.length === due.length ? { $unset: { lastError: 1 } } : {}),
    },
  );
};

// In-app reminders of follow-ups that fell due: to the assignee, else the
// panel's owner; once each.
const remindFollowUps = async () => {
  const due = await BizActivity.find({ kind: "followUp", doneAt: { $exists: false }, remindedAt: { $exists: false }, dueAt: { $lte: new Date() } })
    .limit(200)
    .populate("contact", "name phone")
    .lean<{ _id: unknown; ownerKind: string; ownerId: unknown; assignee?: unknown; text: string; contact?: { name?: string; phone?: string } }[]>();
  for (const f of due) {
    const claimed = await BizActivity.updateOne({ _id: f._id, remindedAt: { $exists: false } }, { $set: { remindedAt: new Date() } });
    if (!claimed.modifiedCount) continue;
    const user = f.assignee || (await orgInfo(ownerOf(f)).catch(() => null))?.user;
    if (!user) continue;
    await Notification.create({
      user,
      source: "System",
      title: "پیگیری بیمار",
      message: `موعد پیگیری «${f.text}» برای ${f.contact?.name || f.contact?.phone || ""} رسیده است.`,
    }).catch(() => {});
  }
};

let running = false;
let lastAttribution = 0;
export const runAutomationSweep = async () => {
  if (running) return;
  running = true;
  try {
    await remindFollowUps().catch((err) => console.log("[crm] reminders failed:", err));
    const list = await BizAutomation.find({ enabled: true }).sort({ lastRunAt: 1 }).limit(100).lean<IBizAutomation[]>();
    for (const a of list) await runAutomation(a).catch((err) => console.log(`[crm] automation ${a._id} failed:`, err));
    // bookings that followed a message, every half hour
    if (Date.now() - lastAttribution > 30 * 60_000) {
      lastAttribution = Date.now();
      const owners = await BizMessage.aggregate([
        { $match: { status: "sent", bookedAt: { $exists: false }, sentAt: { $gte: new Date(Date.now() - 15 * DAY) } } },
        { $group: { _id: { k: "$ownerKind", id: "$ownerId" } } },
        { $limit: 200 },
      ]);
      for (const o of owners)
        await attributeBookings({ kind: o._id.k, id: String(o._id.id) } as BizOwner, { ownerKind: o._id.k, ownerId: o._id.id }).catch(() => 0);
    }
  } finally {
    running = false;
  }
};

export const startAutomationJob = () => {
  setInterval(() => runAutomationSweep().catch((err) => console.log("[crm] sweep failed:", err)), 5 * 60_000);
};
