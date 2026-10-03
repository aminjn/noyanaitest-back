import mongoose from "mongoose";
import crypto from "crypto";
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

type Seen = { user: string; visits: number; orders: number; spent: number; first: Date; last: Date; identity?: unknown };

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
      });
  }
};

// visits: booked and not cancelled
const visitsWhere = async (owner: BizOwner): Promise<Record<string, unknown> | null> => {
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
  return Reservation.aggregate([
    { $match: { ...where, status: { $in: ["active", "completed", "noShow"] }, user: { $exists: true } } },
    { $sort: { date: 1 } },
    {
      $group: {
        _id: "$user",
        visits: { $sum: 1 },
        spent: { $sum: { $ifNull: ["$total", 0] } },
        first: { $min: "$date" },
        last: { $max: "$date" },
        identity: { $last: "$patient" },
      },
    },
    { $project: { user: "$_id", visits: 1, orders: { $literal: 0 }, spent: 1, first: 1, last: 1, identity: 1 } },
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
            ...(name ? { name } : {}),
            ...(idn?.gender === "male" || idn?.gender === "female" ? { gender: idn.gender } : {}),
            ...(idn?.dateOfbirth ? { birthYear: new Date(idn.dateOfbirth).getFullYear() } : {}),
          },
          $setOnInsert: { createdAt: new Date(), source: s.visits ? "visit" : "order", optCode: newOptCode(), tags: [], smsOptOut: false, isActive: true },
        },
        upsert: true,
      },
    });
  }
  if (ops.length) await BizContact.collection.bulkWrite(ops as never, { ordered: false }).catch((err) => console.log("[crm] sync failed:", err));
};

// ---------------------------------------------------------------- audience

// The contacts a campaign with this audience reaches: active, with a mobile,
// not opted out of this owner or of all Noyan campaigns.
export const audienceFilter = async (owner: BizOwner, a: Partial<IBizAudience>) => {
  const and: Record<string, unknown>[] = [{ ...own(owner), isActive: true, smsOptOut: { $ne: true } }];
  if (a.tags?.length) and.push({ tags: { $in: a.tags } });
  if (a.sources?.length) and.push({ source: { $in: a.sources } });
  if (a.gender) and.push({ gender: a.gender });
  if (a.minVisits) and.push({ $expr: { $gte: [{ $add: ["$visits", "$orders"] }, a.minVisits] } });
  if (a.inactiveDays) and.push({ lastSeenAt: { $lte: new Date(Date.now() - a.inactiveDays * DAY) } });
  if (a.activeDays) and.push({ lastSeenAt: { $gte: new Date(Date.now() - a.activeDays * DAY) } });
  return { $and: and };
};

export const audienceContacts = async (owner: BizOwner, a: Partial<IBizAudience>) => {
  const rows = await BizContact.find(await audienceFilter(owner, a)).select("phone name optCode").lean<IBizContact[]>();
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
  const items: { kind: string; at: Date; text?: string; status?: string; id?: string; dueAt?: Date; doneAt?: Date }[] = [];
  if (contact.user) {
    const where = await visitsWhere(owner);
    if (where) {
      const rs = await Reservation.find({ ...where, user: contact.user })
        .sort({ date: -1 })
        .limit(30)
        .select("date status")
        .lean<{ _id: unknown; date: Date; status: string }[]>();
      for (const r of rs) items.push({ kind: "visit", at: r.date, status: r.status, id: String(r._id) });
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
  const acts = await BizActivity.find({ ...own(owner), contact: contact._id }).sort({ createdAt: -1 }).limit(100).lean();
  for (const a of acts)
    items.push({ kind: a.kind, at: a.createdAt, text: a.text, id: String(a._id), dueAt: a.dueAt, doneAt: a.doneAt });
  return items.sort((x, y) => +new Date(y.at) - +new Date(x.at));
};
