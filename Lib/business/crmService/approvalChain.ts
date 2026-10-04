import BizApproval, { IBizInboxTask as IBizApproval } from "../../../Models/BizInboxTask";
import BizReturn, { IBizReturn } from "../../../Models/BizReturn";
import AppError from "../../AppError";
import { BizOwner } from "../coa";
import { crmLink, notify, oid, own, ownerOfDoc, isOwnerUser } from "./common";
import { decideFlowApproval } from "./flow";

// The inbox («کارتابل», 2026-10), nexxacrm's lib/approval-chain.ts: a
// request carries its approvers in order (`approverChain`) and the level it
// is at; the current level's approver gets a task in their inbox; approving
// moves to the next level or, at the end, approves the request; rejecting
// rejects it. A request type is one row here.

type ChainRow = { _id: unknown; ownerKind: string; ownerId: unknown; number: number; requester: unknown; approverChain: unknown[]; currentLevel: number; status: string };
type Cfg = {
  load: (owner: BizOwner, id: unknown) => Promise<ChainRow | null>;
  set: (id: unknown, data: Record<string, unknown>) => Promise<unknown>;
  title: (r: ChainRow) => string;
  link: string;
};

export const CHAIN_TYPES: Record<string, Cfg> = {
  return: {
    load: (owner, id) => BizReturn.findOne({ ...own(owner), _id: oid(id) }).lean<IBizReturn>() as Promise<ChainRow | null>,
    set: (id, data) => BizReturn.updateOne({ _id: id }, { $set: data }),
    title: (r) => `درخواست مرجوعی شماره‌ی ${r.number}`,
    link: "returns",
  },
};

export const createLevelTask = async (type: string, row: ChainRow) => {
  const cfg = CHAIN_TYPES[type];
  const approver = row.approverChain[row.currentLevel];
  if (!cfg || !approver) return false;
  const owner = ownerOfDoc(row);
  await BizApproval.create({
    ...own(owner),
    entityType: type,
    entityId: String(row._id),
    level: row.currentLevel,
    title: `تأیید ${cfg.title(row)}`,
    approver,
  });
  await notify(approver, "تأیید لازم است", `«تأیید ${cfg.title(row)}» در کارتابل شماست.`, crmLink(owner, "inbox"));
  return true;
};

const advanceChain = async (a: IBizApproval, decision: "approved" | "rejected", note?: string) => {
  const cfg = CHAIN_TYPES[a.entityType];
  if (!cfg) return;
  const owner = ownerOfDoc(a);
  const row = await cfg.load(owner, a.entityId);
  if (!row || row.status !== "pending" || row.currentLevel !== a.level) return;
  const link = crmLink(owner, cfg.link);
  if (decision === "rejected") {
    await cfg.set(row._id, { status: "rejected", ...(note ? { rejectReason: note.slice(0, 500) } : {}) });
    await notify(row.requester, "درخواست رد شد", `${cfg.title(row)} رد شد.`, link);
    return;
  }
  const next = row.currentLevel + 1;
  if (next < row.approverChain.length) {
    await cfg.set(row._id, { currentLevel: next });
    await createLevelTask(a.entityType, { ...row, currentLevel: next });
  } else {
    await cfg.set(row._id, { status: "approved" });
    await notify(row.requester, "درخواست تأیید شد", `${cfg.title(row)} تأیید شد.`, link);
  }
};

// a decision in the inbox: only its approver (or the panel's owner), once
export const decideApproval = async (owner: BizOwner, id: unknown, user: unknown, decision: "approved" | "rejected", note?: string) => {
  const a = await BizApproval.findOne({ ...own(owner), _id: oid(id) }).lean<IBizApproval>();
  if (!a) throw new AppError("این مورد در کارتابل پیدا نشد", 404);
  if (String(a.approver) !== String(user) && !(await isOwnerUser(owner, user))) throw new AppError("این تصمیم با شخص دیگری است", 403);
  if (decision === "rejected" && !note?.trim()) throw new AppError("دلیل رد را بنویسید", 400);
  const claimed = await BizApproval.findOneAndUpdate(
    { _id: a._id, status: "pending" },
    { $set: { status: decision, decidedAt: new Date(), ...(note ? { note: note.slice(0, 500) } : {}) } },
    { new: true },
  ).lean<IBizApproval>();
  if (!claimed) throw new AppError("درباره‌ی این مورد قبلاً تصمیم گرفته شده است", 400);
  if (claimed.entityType === "flow") await decideFlowApproval(claimed, decision);
  else await advanceChain(claimed, decision, note);
  return claimed;
};

export const cancelChainTasks = (type: string, id: unknown) =>
  BizApproval.updateMany({ entityType: type, entityId: String(id), status: "pending" }, { $set: { status: "cancelled", decidedAt: new Date() } });
