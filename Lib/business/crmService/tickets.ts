import BizTicket, { BizTicketPriority, IBizTicket } from "../../../Models/BizTicket";
import { BizOwner } from "../coa";
import { crmLink, notify, own, team } from "./common";

// Patient tickets (2026-10), nexxacrm's tickets + lib/ticket-sla.ts.

// ---------------------------------------------------------------- SLA (pure)

export type SlaHours = { response: number; resolve: number };
export const SLA_HOURS: Record<BizTicketPriority, SlaHours> = {
  urgent: { response: 1, resolve: 4 },
  high: { response: 2, resolve: 8 },
  normal: { response: 8, resolve: 24 },
  low: { response: 24, resolve: 72 },
};
const HOUR = 36e5;

export const computeSla = (priority: string, createdAtMs: number) => {
  const h = SLA_HOURS[priority as BizTicketPriority] || SLA_HOURS.normal;
  return { responseDueMs: createdAtMs + h.response * HOUR, resolveDueMs: createdAtMs + h.resolve * HOUR };
};

export type SlaBreach = "none" | "response" | "resolve";
// the resolve breach is the worse one and wins
export const slaBreach = (now: number, responseDueMs: number | null, resolveDueMs: number | null, firstResponded: boolean, resolved: boolean): SlaBreach => {
  if (!resolved && resolveDueMs != null && now > resolveDueMs) return "resolve";
  if (!firstResponded && responseDueMs != null && now > responseDueMs) return "response";
  return "none";
};

export const breachOf = (t: Pick<IBizTicket, "responseDueAt" | "resolveDueAt" | "firstResponseAt" | "status">, now = Date.now()) =>
  slaBreach(
    now,
    t.responseDueAt ? +new Date(t.responseDueAt) : null,
    t.resolveDueAt ? +new Date(t.resolveDueAt) : null,
    !!t.firstResponseAt,
    t.status === "resolved" || t.status === "closed",
  );

// ---------------------------------------------------------------- assign

// round-robin by load: the team member with the fewest open tickets (the
// owner when there is no team); ties go to whoever comes first
export const pickAssignee = async (owner: BizOwner, fallback?: unknown) => {
  const members = await team(owner);
  if (!members.length) return fallback ? String(fallback) : null;
  const load = await BizTicket.aggregate([
    { $match: { ...own(owner), status: { $in: ["open", "pending"] }, assignee: { $exists: true } } },
    { $group: { _id: "$assignee", n: { $sum: 1 } } },
  ]);
  const by = new Map(load.map((l: { _id: unknown; n: number }) => [String(l._id), l.n]));
  return [...members].sort((a, b) => (by.get(a._id) || 0) - (by.get(b._id) || 0))[0]._id;
};

// ---------------------------------------------------------------- SLA job

// a breach is told to the assignee once per kind
export const runTicketSweep = async () => {
  const now = new Date();
  const rows = await BizTicket.find({
    status: { $in: ["open", "pending"] },
    $or: [{ resolveDueAt: { $lt: now }, breachNotified: { $ne: "resolve" } }, { firstResponseAt: { $exists: false }, responseDueAt: { $lt: now }, breachNotified: { $exists: false } }],
  })
    .limit(200)
    .lean<IBizTicket[]>();
  for (const t of rows) {
    const b = breachOf(t, +now);
    if (b === "none") continue;
    const claimed = await BizTicket.updateOne({ _id: t._id, breachNotified: b === "resolve" ? { $ne: "resolve" } : { $exists: false } }, { $set: { breachNotified: b } });
    if (!claimed.modifiedCount || !t.assignee) continue;
    const owner = { kind: t.ownerKind, id: String(t.ownerId) } as BizOwner;
    await notify(
      t.assignee,
      b === "resolve" ? "مهلت حل درخواست گذشت" : "مهلت پاسخ درخواست گذشت",
      `درخواست شماره‌ی ${t.number.toLocaleString("fa-IR")} («${t.subject}») از مهلت گذشته است.`,
      crmLink(owner, `tickets/${t._id}`),
    );
  }
};
