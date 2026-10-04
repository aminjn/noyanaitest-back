import mongoose from "mongoose";
import BizRequest, { bizFinanceRequestKinds, BizRequestKind, bizRequestKinds, IBizRequest } from "../../Models/BizRequest";
import Notification from "../../Models/Notification";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";
import { nextDocNumber } from "./voucher";
import { panelPath } from "./payments";

// The panel's one approval queue («کارتابل», 2026-10). Doctolib Pro and
// Docplanner keep a single "to approve" list per practice, and Nexxa's
// lib/approval-chain.ts gives every request type the same chain; NoyanAI had
// three (the accounting desk, the CRM sales approvals, the CRM engagement
// inbox), each with its own rules. Now every kind is one BizRequest row and
// this is its only engine:
//   - file: the approvers in order (team members only); with none the item
//     is approved at once and waits for «اجرا»;
//   - decide: only the current level's approver or the panel's owner, one
//     level at a time; a rejection needs a reason and ends it; the decision
//     is claimed atomically on (status, level), so two clicks count once;
//   - the last approval applies the kind's effect, claimed atomically
//     (approved -> done); a failure gives the claim back with the reason and
//     «اجرا» tries again - the effect never runs twice;
//   - reopen: a rejected item goes back to its first approver;
//   - cancel: the requester or the owner, while pending or approved.
// Each kind brings its own effect and side hooks (below); the modules are
// loaded lazily so the domains can file items here without an import loop.

const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
const isId = (v: unknown) => !!v && /^[0-9a-f]{24}$/i.test(String((v as { _id?: unknown })?._id ?? v));

export type KindHooks = {
  // the Persian title used in notifications (translated when read)
  title: string;
  // which part of the panel the kind belongs to (who sees it)
  domain: "finance" | "crm" | "both";
  // the final approval's effect; runs once
  apply?: (owner: BizOwner, r: IBizRequest, by?: unknown) => Promise<{ ref?: string; payment?: unknown } | void>;
  onReject?: (owner: BizOwner, r: IBizRequest, note: string) => Promise<unknown>;
  onCancel?: (owner: BizOwner, r: IBizRequest) => Promise<unknown>;
  // throws when the source moved on and the item cannot be reopened
  onReopen?: (owner: BizOwner, r: IBizRequest) => Promise<unknown>;
  reopenable?: boolean;
  // the requester may cancel it from the inbox (a workflow step is
  // cancelled with its run)
  cancellable?: boolean;
};

const FINANCE_TITLES: Record<string, string> = {
  petty: "درخواست تنخواه",
  expense: "درخواست هزینه",
  payment: "درخواست پرداخت",
  checkIssue: "درخواست صدور چک",
  fundTransfer: "درخواست انتقال وجه",
  invoice: "تأیید صورتحساب",
};

const HOOKS: Record<BizRequestKind, () => Promise<KindHooks>> = {
  ...(Object.fromEntries(
    bizFinanceRequestKinds.map((k) => [k, () => import("./requests").then((m) => ({ title: FINANCE_TITLES[k], domain: "finance" as const, apply: m.applyFinanceRequest }))]),
  ) as Record<(typeof bizFinanceRequestKinds)[number], () => Promise<KindHooks>>),
  plan: () => import("./crmSales").then((m) => m.salesHooks.plan),
  discount: () => import("./crmSales").then((m) => m.salesHooks.discount),
  credit: () => import("./crmSales").then((m) => m.salesHooks.credit),
  return: () => import("./crmService/returns").then((m) => m.returnHooks),
  flow: () => import("./crmService/flow").then((m) => m.flowHooks),
};
export const hooksOf = (kind: BizRequestKind) => (HOOKS[kind] || (() => Promise.reject(new AppError("نوع درخواست نامعتبر است", 400))))();

export const FINANCE_KINDS: readonly BizRequestKind[] = bizFinanceRequestKinds;
export const CRM_KINDS: readonly BizRequestKind[] = ["plan", "discount", "credit", "flow"];
// a return is both: the accounting desk and the CRM file it
export const SHARED_KINDS: readonly BizRequestKind[] = ["return"];

// the counter each kind numbers from (kept from before the merge, so the
// numbers go on where they were)
const counterOf = (kind: BizRequestKind) => (["plan", "discount", "credit"].includes(kind) ? `crmApproval:${kind}` : `request:${kind}`);

// ---------------------------------------------------------------- team

type Member = { _id: string; name: string; owner?: boolean };
// the people who may approve: the owner and the team (Secretary)
export const teamOf = async (owner: BizOwner): Promise<Member[]> => {
  if (owner.kind === "platform" || !owner.id) return [];
  const { team } = await import("./crmService/common");
  const members = await team(owner).catch(() => []);
  return members.map((m) => ({ _id: m._id, name: m.name, ...(m.role === "owner" ? { owner: true } : {}) }));
};
export const ownerUserOf = async (owner: BizOwner) => (await teamOf(owner)).find((m) => m.owner)?._id || "";

const link = (owner: BizOwner) => (owner.kind === "platform" ? "" : `/${panelPath(owner.kind)}/kartabl`);
const notify = async (owner: BizOwner, user: unknown, title: string, message: string) => {
  if (!user || owner.kind === "platform") return;
  await Notification.create({ user, source: "System", title, message, link: link(owner) }).catch(() => undefined);
};
const numberText = (n: number) => n.toLocaleString("fa-IR");
const labelOf = async (r: IBizRequest) => (r.kind === "flow" ? r.title || "" : (await hooksOf(r.kind)).title);
const notifyTurn = async (owner: BizOwner, r: IBizRequest) => {
  const approver = r.chain[r.level];
  if (r.kind === "flow") return notify(owner, approver, "تأیید لازم است", `«${r.title || ""}» در کارتابل شماست.`);
  return notify(owner, approver, "درخواست تأیید", `${await labelOf(r)} شماره‌ی ${numberText(r.number)} منتظر تأیید شماست.`);
};
const notifyResult = async (owner: BizOwner, r: IBizRequest, outcome: "approved" | "rejected" | "failed") => {
  if (r.kind === "flow") return;
  const tail = { approved: "تأیید شد.", rejected: "رد شد.", failed: "تأیید شد ولی اعمال نشد." }[outcome];
  await notify(owner, r.requester, "نتیجه‌ی درخواست", `${await labelOf(r)} شماره‌ی ${numberText(r.number)} ${tail}`);
};

// ---------------------------------------------------------------- file

export type FileInput = Partial<Omit<IBizRequest, "_id" | "ownerKind" | "ownerId" | "kind" | "chain" | "chainNames" | "status" | "level" | "decisions">> & {
  kind: BizRequestKind;
  // the approvers in order; anyone not on the team is dropped
  approvers?: unknown[];
  // with no approver given: the panel's owner decides (instead of the item
  // being approved at once)
  ownerDecides?: boolean;
};

export const fileRequest = async (owner: BizOwner, input: FileInput, by?: unknown) => {
  const { kind, approvers, ownerDecides, ...fields } = input;
  if (!bizRequestKinds.includes(kind)) throw new AppError("نوع درخواست نامعتبر است", 400);
  const members = await teamOf(owner);
  let chain = Array.from(new Set((Array.isArray(approvers) ? approvers : []).map(String)))
    .filter((a) => members.some((m) => m._id === a))
    .slice(0, 5);
  if (!chain.length && ownerDecides) {
    const top = members.find((m) => m.owner)?._id;
    if (!top) throw new AppError("تأییدکننده‌ای برای این درخواست تعریف نشده است", 400);
    chain = [top];
  }
  const requester = isId(by) ? oid(by) : undefined;
  const number = fields.number || (await nextDocNumber(counterOf(kind), owner));
  const doc = await BizRequest.create({
    ...(owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: oid(owner.id) }),
    ...fields,
    kind,
    number,
    requester,
    requesterName: fields.requesterName || members.find((m) => m._id === String(requester || ""))?.name || undefined,
    status: chain.length ? "pending" : "approved",
    chain: chain.map(oid),
    chainNames: chain.map((c) => members.find((m) => m._id === c)?.name || ""),
    level: 0,
  });
  const row = doc.toObject() as IBizRequest;
  if (chain.length) await notifyTurn(owner, row);
  return row;
};

// ---------------------------------------------------------------- decide

export const decideRequest = async (owner: BizOwner, id: unknown, user: unknown, decision: "approved" | "rejected", note?: string) => {
  if (!isId(id)) throw new AppError("درخواست پیدا نشد", 404);
  const r = await BizRequest.findOne({ ...ownerFilter(owner), _id: oid(id) }).lean<IBizRequest>();
  if (!r) throw new AppError("درخواست پیدا نشد", 404);
  if (r.status !== "pending") throw new AppError("این درخواست در انتظار تأیید نیست", 400);
  const members = await teamOf(owner);
  const isOwner = members.some((m) => m.owner && m._id === String(user));
  if (!isOwner && String(r.chain[r.level] || "") !== String(user)) throw new AppError("تأیید این مرحله با شما نیست", 403);
  const reason = (note || "").trim().slice(0, 500);
  if (decision === "rejected" && !reason) throw new AppError("دلیل رد را بنویسید", 400);
  const last = r.level + 1 >= r.chain.length;
  const now = new Date();
  const set: Record<string, unknown> =
    decision === "rejected" ? { status: "rejected", decidedAt: now, rejectReason: reason } : last ? { status: "approved", decidedAt: now } : { level: r.level + 1 };
  const claimed = await BizRequest.findOneAndUpdate(
    { _id: r._id, status: "pending", level: r.level },
    {
      $set: set,
      $push: { decisions: { by: isId(user) ? oid(user) : undefined, name: members.find((m) => m._id === String(user))?.name, level: r.level, decision, note: reason || undefined, at: now } },
    },
    { new: true },
  ).lean<IBizRequest>();
  if (!claimed) throw new AppError("درباره‌ی این مورد قبلاً تصمیم گرفته شده است", 400);
  const hooks = await hooksOf(claimed.kind);
  if (decision === "rejected") {
    await hooks.onReject?.(owner, claimed, reason);
    await notifyResult(owner, claimed, "rejected");
    return claimed;
  }
  if (!last) {
    await notifyTurn(owner, claimed);
    return claimed;
  }
  const done = await executeRequest(owner, String(claimed._id), user, true);
  await notifyResult(owner, claimed, done?.status === "done" ? "approved" : "failed");
  return done;
};

// Applies an approved item once (approved -> done, claimed atomically); a
// failure gives the claim back with the reason.
export const executeRequest = async (owner: BizOwner, id: string, by?: unknown, auto = false) => {
  if (!isId(id)) throw new AppError("درخواست پیدا نشد", 404);
  const claim = await BizRequest.findOneAndUpdate(
    { ...ownerFilter(owner), _id: oid(id), status: "approved" },
    { $set: { status: "done", executedAt: new Date() }, $unset: { error: 1 } },
    { new: true },
  ).lean<IBizRequest>();
  if (!claim) throw new AppError("فقط درخواست تأییدشده اجرا می‌شود", 400);
  try {
    const out = (await (await hooksOf(claim.kind)).apply?.(owner, claim, by)) || {};
    if (out.ref || out.payment) await BizRequest.updateOne({ _id: claim._id }, { $set: { ...(out.ref ? { voucherRef: out.ref } : {}), ...(out.payment ? { payment: out.payment } : {}) } });
  } catch (err) {
    await BizRequest.updateOne(
      { _id: claim._id, status: "done" },
      { $set: { status: "approved", error: String((err as Error)?.message || err).slice(0, 300) }, $unset: { executedAt: 1 } },
    );
    if (!auto) throw err;
  }
  return BizRequest.findById(claim._id).lean<IBizRequest>();
};

// ---------------------------------------------------------------- cancel / reopen

export const cancelRequest = async (owner: BizOwner, id: unknown, user: unknown) => {
  if (!isId(id)) throw new AppError("درخواست پیدا نشد", 404);
  const r = await BizRequest.findOne({ ...ownerFilter(owner), _id: oid(id) }).lean<IBizRequest>();
  if (!r) throw new AppError("درخواست پیدا نشد", 404);
  const hooks = await hooksOf(r.kind);
  if (hooks.cancellable === false) throw new AppError("این مورد از صفحه‌ی خودش لغو می‌شود", 400);
  const isOwner = (await ownerUserOf(owner)) === String(user);
  if (!isOwner && String(r.requester || "") !== String(user)) throw new AppError("فقط ثبت‌کننده یا مالک درخواست را لغو می‌کند", 403);
  const row = await BizRequest.findOneAndUpdate({ _id: r._id, status: { $in: ["pending", "approved"] } }, { $set: { status: "cancelled" } }, { new: true }).lean<IBizRequest>();
  if (!row) throw new AppError("این درخواست دیگر لغو نمی‌شود", 400);
  await hooks.onCancel?.(owner, row);
  return row;
};

// a rejected item back to its first approver (the history stays)
export const reopenRequest = async (owner: BizOwner, id: unknown, user: unknown) => {
  if (!isId(id)) throw new AppError("درخواست پیدا نشد", 404);
  const r = await BizRequest.findOne({ ...ownerFilter(owner), _id: oid(id) }).lean<IBizRequest>();
  if (!r) throw new AppError("درخواست پیدا نشد", 404);
  if (r.status !== "rejected") throw new AppError("فقط درخواست ردشده دوباره باز می‌شود", 400);
  const hooks = await hooksOf(r.kind);
  if (hooks.reopenable === false || !r.chain.length) throw new AppError("این مورد دوباره باز نمی‌شود", 400);
  const members = await teamOf(owner);
  const isOwner = members.some((m) => m.owner && m._id === String(user));
  if (!isOwner && String(r.requester || "") !== String(user)) throw new AppError("فقط ثبت‌کننده یا مالک درخواست را دوباره باز می‌کند", 403);
  await hooks.onReopen?.(owner, r);
  const row = await BizRequest.findOneAndUpdate(
    { _id: r._id, status: "rejected" },
    {
      $set: { status: "pending", level: 0 },
      $unset: { rejectReason: 1, decidedAt: 1 },
      $push: { decisions: { by: isId(user) ? oid(user) : undefined, name: members.find((m) => m._id === String(user))?.name, level: 0, decision: "reopened", at: new Date() } },
    },
    { new: true },
  ).lean<IBizRequest>();
  if (!row) throw new AppError("این درخواست دیگر لغو نمی‌شود", 400);
  await notifyTurn(owner, row);
  return row;
};

// the open items of a source that went away (a plan edited, a run or a
// return cancelled): closed without their effect
export const cancelOpen = (filter: Record<string, unknown>) =>
  BizRequest.updateMany({ ...filter, status: { $in: ["pending", "approved"] } }, { $set: { status: "cancelled" } });

// ---------------------------------------------------------------- read

// what a team member may see: the owner everything; a secretary the kinds
// of the parts they read, and whatever they asked for or must decide
export type Grant = "FULL" | Record<string, unknown> | null | undefined;
export const visibleKinds = (grant: Grant): BizRequestKind[] => {
  if (grant === "FULL") return [...bizRequestKinds];
  const g = (grant || {}) as Record<string, unknown>;
  return [...(g.readFinance ? FINANCE_KINDS : []), ...(g.readCrm ? CRM_KINDS : []), ...(g.readFinance || g.readCrm ? SHARED_KINDS : [])];
};

const visibleFilter = (owner: BizOwner, user: unknown, grant: Grant) => {
  const me = isId(user) ? oid(user) : null;
  return {
    ...ownerFilter(owner),
    $or: [{ kind: { $in: visibleKinds(grant) } }, ...(me ? [{ chain: me }, { requester: me }] : [])],
  };
};
const myTurnExpr = (user: unknown) => ({ $eq: [{ $arrayElemAt: ["$chain", "$level"] }, oid(user)] });

export const listRequests = async (
  owner: BizOwner,
  q: { kind?: string; status?: string; scope?: "mine" | "all"; user: unknown; grant: Grant },
) => {
  const filter: Record<string, unknown> = visibleFilter(owner, q.user, q.grant);
  if (q.kind && bizRequestKinds.includes(q.kind as BizRequestKind)) filter.kind = q.kind;
  if (q.status && q.status !== "any") filter.status = q.status;
  if (q.scope === "mine" && isId(q.user)) {
    // waiting for my decision, or approved and waiting to be applied by me
    filter.$and = [
      {
        $or: [
          { status: "pending", $expr: myTurnExpr(q.user) },
          { status: "approved", requester: oid(q.user) },
        ],
      },
    ];
  }
  const items = await BizRequest.find(filter)
    .sort({ createdAt: -1 })
    .limit(300)
    .populate("plan", "number subject total")
    .populate("invoice", "number total party")
    .populate("contact", "name phone")
    .populate("returnDoc", "number kind action status")
    .lean<IBizRequest[]>();
  const counts = await BizRequest.aggregate([
    { $match: { ...visibleFilter(owner, q.user, q.grant), status: { $in: ["pending", "approved"] } } },
    { $group: { _id: { kind: "$kind", status: "$status" }, n: { $sum: 1 } } },
  ]);
  const me = String(q.user || "");
  return {
    items: items.map((r) => ({ ...r, myTurn: r.status === "pending" && String(r.chain[r.level] || "") === me })),
    counts: counts.map((c) => ({ kind: c._id.kind, status: c._id.status, n: c.n })),
  };
};

// the items waiting for this user's decision (the menu's count)
export const myPendingCount = async (owner: BizOwner, user: unknown) =>
  isId(user) ? BizRequest.countDocuments({ ...ownerFilter(owner), status: "pending", $expr: myTurnExpr(user) }) : 0;
