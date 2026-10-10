import BizTicket, { BizTicketPriority, IBizTicket } from "../../../Models/BizTicket";
import { BizOwner } from "../coa";
import { crmLink, notify, own, ownerUser, team } from "./common";

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

// The moves a ticket's status may make (Zendesk / Freshdesk): the team
// answers (open -> pending), solves or closes it; a solved one opens again
// when the patient writes back; closed is final - a new message is a new
// ticket.
export const TICKET_MOVES: Record<string, readonly string[]> = {
  open: ["pending", "resolved", "closed"],
  pending: ["open", "resolved", "closed"],
  resolved: ["open", "closed"],
  closed: [],
};
export const canMoveTicket = (from: string, to: string) => from === to || (TICKET_MOVES[from] || []).includes(to);

// A priority change re-applies the SLA from the ticket's opening (the way an
// SLA policy is re-evaluated): a clock already met is kept, and a deadline
// moved into the future may be told again when it passes.
export const slaOnPriority = (t: Pick<IBizTicket, "createdAt" | "firstResponseAt" | "resolvedAt" | "breachNotified">, priority: string, now = Date.now()) => {
  const sla = computeSla(priority, +new Date(t.createdAt || now));
  const set: Record<string, unknown> = {};
  if (!t.firstResponseAt) set.responseDueAt = new Date(sla.responseDueMs);
  if (!t.resolvedAt) set.resolveDueAt = new Date(sla.resolveDueMs);
  const again =
    (t.breachNotified === "resolve" && !t.resolvedAt && sla.resolveDueMs > now) ||
    (t.breachNotified === "response" && !t.firstResponseAt && sla.responseDueMs > now);
  return { set, unsetBreach: again };
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
    if (!claimed.modifiedCount) continue;
    const owner = { kind: t.ownerKind, id: String(t.ownerId) } as BizOwner;
    // nobody on it: the panel's owner hears of it
    const to = t.assignee || (await ownerUser(owner));
    if (!to) continue;
    await notify(
      to,
      b === "resolve" ? "مهلت حل درخواست گذشت" : "مهلت پاسخ درخواست گذشت",
      `درخواست شماره‌ی ${t.number.toLocaleString("fa-IR")} («${t.subject}») از مهلت گذشته است.`,
      crmLink(owner, `tickets/${t._id}`),
    );
  }
};
