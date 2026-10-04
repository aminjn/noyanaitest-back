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
import { BizOwner } from "./coa";

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

const visitRows = async (owner: BizOwner): Promise<Seen[]> => {
  const where = await visitsWhere(owner);
  if (!where) return [];
  // visits: attended (active / completed); a no-show of the patient's own is
  // counted apart (it still paid)
  const attended = { $in: ["$status", ["active", "completed"]] };
  const missed = { $and: [{ $eq: ["$status", "noShow"] }, { $ne: ["$noShowParty", "doctor"] }] };
  return Reservation.aggregate([
    { $match: { ...where, status: { $in: ["active", "completed", "noShow"] }, user: { $exists: true } } },
    { $sort: { date: 1 } },
    {
      $group: {
        _id: "$user",
        visits: { $sum: { $cond: [attended, 1, 0] } },
        noShows: { $sum: { $cond: [missed, 1, 0] } },
        spent: { $sum: { $ifNull: ["$total", 0] } },
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
const orderLines = async (owner: BizOwner): Promise<[string, mongoose.Types.ObjectId[]][]> => {
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
  const identities = await UserIdentity.find({
    $or: [{ _id: { $in: identityIds } }, { user: { $in: users.map((u) => u._id) } }],
  })
    .select("user givenName lastName gender dateOfbirth")
    .lean<{ _id: unknown; user?: unknown; givenName?: string; lastName?: string; gender?: string; dateOfbirth?: Date }[]>();
  const byId = new Map(identities.map((i) => [String(i._id), i]));
  const byUser = new Map(identities.map((i) => [String(i.user), i]));
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
  for (const u of users) {
    const s = seen.get(String(u._id))!;
    const phone = normalizeMobile(u.phone);
    if (!phone) continue;
    // the account holder's own identity first: the booking may be for a child
    const idn = byUser.get(String(u._id)) || byId.get(String(s.identity));
    const name = idn ? `${idn.givenName || ""} ${idn.lastName || ""}`.trim() : "";
    ops.push({
      updateOne: {
        filter: { ...own(owner), phone },
        update: {
          $set: {
            updatedAt: new Date(),
            user: u._id,
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
            ...(idn?.gender === "male" || idn?.gender === "female" ? { gender: idn.gender } : {}),
            ...(idn?.dateOfbirth
              ? {
                  birthYear: new Date(idn.dateOfbirth).getFullYear(),
                  birthDate: new Date(idn.dateOfbirth),
                  birthMD: jalaliMD(idn.dateOfbirth),
                }
              : {}),
          },
          $setOnInsert: {
            createdAt: new Date(),
            source: s.visits || s.noShows ? "visit" : "order",
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
  const year = new Date().getFullYear();
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
    const where = await visitsWhere(owner);
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
  for (const a of acts)
    items.push({ kind: a.kind, at: a.createdAt, text: a.text, id: String(a._id), dueAt: a.dueAt, doneAt: a.doneAt });
  for (const m of msgs)
    items.push({ kind: "sms", at: m.sentAt || m.createdAt, text: m.text, status: m.status, id: String(m._id), source: m.source, clicks: m.clicks });
  return items.sort((x, y) => +new Date(y.at) - +new Date(x.at));
};
