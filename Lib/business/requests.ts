import mongoose from "mongoose";
import BizRequest, { BizRequestKind, bizRequestKinds, IBizRequest } from "../../Models/BizRequest";
import BizMoneyAccount, { IBizMoneyAccount } from "../../Models/BizMoneyAccount";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import Secretary from "../../Models/Secretary";
import User from "../../Models/User";
import Notification from "../../Models/Notification";
import AppError from "../AppError";
import { accountFor, BizOwner, ownerFilter } from "./coa";
import { nextDocNumber, postVoucher } from "./voucher";
import { resolveParty } from "./parties";
import { chargePetty, transferFunds, treasuryCredit } from "./treasury";
import { createExpense } from "./expenses";
import { createPayment } from "./payments";
import { issueInvoice } from "./invoices";
import { orgInfo } from "./campaign";
import { panelPath } from "./payments";

// The finance approval desk (کارتابل مالی, 2026-10), a port of Nexxa's
// petty-cash-requests, expense-requests, payment-requests,
// check-issue-requests, fund-transfers, return-requests and
// invoice-approvals with lib/approval-chain and lib/request-effects:
//   - a team member asks; with no approvers the request is approved at once;
//   - the approvers decide in order (one level each); a rejection ends it;
//   - the last approval applies the effect automatically, and «اجرا» does it
//     by hand when the automatic run failed (a closed year, a till short);
//   - applying is claimed atomically (approved -> done), so a double click
//     or two approvers at once never book twice, and a failure gives the
//     claim back;
//   - the requester (or the owner) cancels while it is not done.
// Effects:
//   petty        Dr the petty fund / Cr the till or bank (chargePetty)
//   expense      an expense, paid from the till or bank (Lib/business/expenses.ts)
//   payment      Dr the payee's payable / Cr the till or bank
//   checkIssue   an issued cheque to the payee (Dr payable / Cr 3202)
//   fundTransfer Dr the target till / Cr the source (transferFunds)
//   return       Dr 6201 returns / Cr the patient's receivable (credit note)
//   invoice      the draft invoice is issued (Lib/business/invoices.ts)

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const ownerFields = (owner: BizOwner) =>
  owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: oid(owner.id) };
const isId = (v: unknown) => !!v && mongoose.isValidObjectId(String(v));
const userName = (u?: { firstName?: string; lastName?: string; phone?: string } | null) => [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.phone || "";

// the people who may approve: the owner and the team (Secretary)
export const team = async (owner: BizOwner) => {
  if (owner.kind === "platform" || !owner.id) return [];
  const info = await orgInfo(owner).catch(() => null);
  const secs = await Secretary.find({ owner: oid(owner.id) }).populate({ path: "secretary", select: "firstName lastName phone" }).lean();
  const out: { _id: string; name: string; owner?: boolean }[] = [];
  if (info?.user) {
    const u = await User.findById(info.user).select("firstName lastName phone").lean<{ firstName?: string; lastName?: string; phone?: string }>();
    out.push({ _id: String(info.user), name: userName(u) || info.name, owner: true });
  }
  for (const s of secs) {
    const u = s.secretary as unknown as { _id: unknown; firstName?: string; lastName?: string; phone?: string } | null;
    if (u?._id && !out.some((o) => o._id === String(u._id))) out.push({ _id: String(u._id), name: s.displayName || userName(u) });
  }
  return out;
};

const notify = async (user: unknown, title: string, message: string, owner: BizOwner) => {
  if (!user || owner.kind === "platform") return;
  await Notification.create({ user, source: "System", title, message, link: `/${panelPath(owner.kind)}/finance/requests` }).catch(() => undefined);
};

export type RequestInput = {
  kind: BizRequestKind;
  amount?: number;
  description?: string;
  approvers?: string[];
  money?: string;
  toMoney?: string;
  account?: string;
  center?: string;
  party?: string;
  partyName?: string;
  payKind?: "payment" | "remittance";
  serial?: string;
  bank?: string;
  dueDate?: Date;
  invoice?: string;
  invoiceRef?: string;
};

const checkMoney = async (owner: BizOwner, id: unknown, kind?: IBizMoneyAccount["kind"]) => {
  if (!isId(id)) return null;
  const row = await BizMoneyAccount.findOne({ ...ownerFilter(owner), _id: id, ...(kind ? { kind } : {}) }).lean<IBizMoneyAccount>();
  if (!row) throw new AppError("صندوق یا حساب بانکی را انتخاب کنید", 400);
  return row;
};

export const createRequest = async (owner: BizOwner, d: RequestInput, by?: unknown) => {
  if (!bizRequestKinds.includes(d.kind)) throw new AppError("نوع درخواست نامعتبر است", 400);
  const amount = Math.max(0, Math.round(Number(d.amount) || 0));
  if (d.kind !== "invoice" && !amount) throw new AppError("مبلغ را وارد کنید", 400);
  // what each kind needs before it is filed
  if (d.kind === "petty") await checkMoney(owner, d.toMoney, "petty").then((r) => r || Promise.reject(new AppError("تنخواه پیدا نشد", 404)));
  if (d.kind === "fundTransfer") {
    if (!isId(d.money) || !isId(d.toMoney)) throw new AppError("حساب مبدأ و مقصد را انتخاب کنید", 400);
    if (String(d.money) === String(d.toMoney)) throw new AppError("مبدأ و مقصد نباید یکسان باشند", 400);
  }
  if (d.kind === "expense") {
    const acc = isId(d.account) ? await BizAccount.findOne({ ...ownerFilter(owner), _id: d.account, type: "expense", level: "detail" }).lean<IBizAccount>() : null;
    if (!acc) throw new AppError("نوع هزینه را انتخاب کنید", 400);
  }
  if (d.kind === "invoice" && !isId(d.invoice)) throw new AppError("صورتحساب پیش‌نویس را انتخاب کنید", 400);
  const party = d.party ? await resolveParty(owner, d.party) : null;
  const members = await team(owner);
  const chain = (Array.isArray(d.approvers) ? d.approvers : []).filter((a) => members.some((m) => m._id === String(a))).slice(0, 5);
  const by_ = isId(by) ? await User.findById(by).select("firstName lastName phone").lean<{ firstName?: string; lastName?: string; phone?: string }>() : null;
  const number = await nextDocNumber(`request:${d.kind}`, owner);
  const doc = await BizRequest.create({
    ...ownerFields(owner),
    kind: d.kind,
    number,
    requester: isId(by) ? oid(by) : undefined,
    requesterName: userName(by_),
    amount,
    description: d.description?.trim().slice(0, 500) || undefined,
    status: chain.length ? "pending" : "approved",
    chain: chain.map(oid),
    chainNames: chain.map((c) => members.find((m) => m._id === c)?.name || ""),
    level: 0,
    money: isId(d.money) ? oid(d.money) : undefined,
    toMoney: isId(d.toMoney) ? oid(d.toMoney) : undefined,
    account: isId(d.account) ? oid(d.account) : undefined,
    center: isId(d.center) ? oid(d.center) : undefined,
    party: party?._id,
    partyName: party?.name || d.partyName?.trim().slice(0, 200) || undefined,
    payKind: d.payKind === "remittance" ? "remittance" : d.kind === "payment" ? "payment" : undefined,
    serial: d.serial?.trim().slice(0, 40) || undefined,
    bank: d.bank?.trim().slice(0, 80) || undefined,
    dueDate: d.dueDate && !Number.isNaN(d.dueDate.getTime()) ? d.dueDate : undefined,
    invoice: isId(d.invoice) ? oid(d.invoice) : undefined,
    invoiceRef: d.invoiceRef?.trim().slice(0, 60) || undefined,
  });
  if (chain.length) await notify(chain[0], "درخواست مالی در انتظار تأیید شما", `درخواست شماره‌ی ${number}`, owner);
  return doc.toObject();
};

// one approver's decision at the current level (Nexxa advanceApproval)
export const decideRequest = async (
  owner: BizOwner,
  id: string,
  d: { decision: "approved" | "rejected"; note?: string },
  by: unknown,
  isOwner: boolean,
) => {
  const r = await BizRequest.findOne({ ...ownerFilter(owner), _id: id });
  if (!r) throw new AppError("درخواست پیدا نشد", 404);
  if (r.status !== "pending") throw new AppError("این درخواست در انتظار تأیید نیست", 400);
  const current = r.chain[r.level];
  if (!isOwner && (!current || String(current) !== String(by))) throw new AppError("تأیید این مرحله با شما نیست", 403);
  const u = isId(by) ? await User.findById(by).select("firstName lastName phone").lean<{ firstName?: string; lastName?: string; phone?: string }>() : null;
  r.decisions.push({ by: isId(by) ? oid(by) : undefined, name: userName(u), level: r.level, decision: d.decision, note: d.note?.slice(0, 300), at: new Date() });
  if (d.decision === "rejected") {
    r.status = "rejected";
    await r.save();
    await notify(r.requester, "درخواست مالی رد شد", `درخواست شماره‌ی ${r.number}`, owner);
    return r.toObject();
  }
  if (r.level + 1 < r.chain.length) {
    r.level += 1;
    await r.save();
    await notify(r.chain[r.level], "درخواست مالی در انتظار تأیید شما", `درخواست شماره‌ی ${r.number}`, owner);
    return r.toObject();
  }
  r.status = "approved";
  await r.save();
  // the final approval applies the effect; a failure leaves it approved
  // with the reason, to be applied by hand
  await executeRequest(owner, String(r._id), by, true).catch(() => undefined);
  await notify(r.requester, "درخواست مالی تأیید شد", `درخواست شماره‌ی ${r.number}`, owner);
  return BizRequest.findById(r._id).lean();
};

// Applies an approved request once (approved -> done, claimed atomically).
export const executeRequest = async (owner: BizOwner, id: string, by?: unknown, auto = false) => {
  const claim = await BizRequest.findOneAndUpdate(
    { ...ownerFilter(owner), _id: id, status: "approved" },
    { $set: { status: "done", executedAt: new Date() }, $unset: { error: 1 } },
    { new: true },
  ).lean<IBizRequest>();
  if (!claim) throw new AppError("فقط درخواست تأییدشده اجرا می‌شود", 400);
  try {
    const out = await effect(owner, claim, by);
    await BizRequest.updateOne({ _id: claim._id }, { $set: { voucherRef: out.ref, ...(out.payment ? { payment: out.payment } : {}) } });
  } catch (err) {
    await BizRequest.updateOne({ _id: claim._id, status: "done" }, { $set: { status: "approved", error: String((err as Error)?.message || err).slice(0, 300) }, $unset: { executedAt: 1 } });
    if (!auto) throw err;
  }
  return BizRequest.findById(claim._id).lean();
};

const effect = async (owner: BizOwner, r: IBizRequest, by?: unknown): Promise<{ ref?: string; payment?: unknown }> => {
  const label = r.description || `درخواست شماره‌ی ${r.number}`;
  switch (r.kind) {
    case "petty": {
      const ref = `pettyreq:${r._id}`;
      await chargePetty(owner, { petty: String(r.toMoney), from: String(r.money || ""), amount: r.amount, note: r.description, ref }, by);
      return { ref };
    }
    case "fundTransfer": {
      const v = await transferFunds(owner, { from: String(r.money), to: String(r.toMoney), amount: r.amount, description: label }, by);
      return { ref: v?.ref };
    }
    case "expense": {
      const e = await createExpense(
        owner,
        {
          date: new Date(),
          account: String(r.account),
          description: label,
          amount: r.amount,
          center: r.center ? String(r.center) : undefined,
          vendor: r.partyName,
          payFrom: r.money ? String(r.money) : undefined,
          method: "cash",
        },
        by,
      );
      return { ref: `exp:${(e as { _id: unknown })._id}` };
    }
    case "payment": {
      const ref = `payreq:${r._id}`;
      const credit = await treasuryCredit(owner, r.money, r.amount, "پرداخت");
      await postVoucher(owner, {
        ref,
        date: new Date(),
        description: r.payKind === "remittance" ? "اجرای حواله" : "اجرای درخواست پرداخت",
        source: { type: "request", id: r._id },
        lines: [
          { role: "payable", party: r.party, label, debit: r.amount },
          { ...credit, label: `پرداخت درخواست ${r.number}` },
        ],
        createdBy: by,
      });
      return { ref };
    }
    case "checkIssue": {
      const payable = await accountFor(owner, "payable");
      const p = await createPayment(
        owner,
        {
          direction: "out",
          date: new Date(),
          amount: r.amount,
          method: "cheque",
          money: r.money ? String(r.money) : undefined,
          against: "account",
          account: String(payable._id),
          party: r.partyName,
          partyRef: r.party ? String(r.party) : undefined,
          description: label,
          cheque: { number: r.serial || `REQ-${r.number}`, bank: r.bank || "—", dueDate: r.dueDate || new Date() },
        },
        by,
      );
      return { ref: `pay:${(p as { _id: unknown })._id}`, payment: (p as { _id: unknown })._id };
    }
    case "return": {
      const ref = `retreq:${r._id}`;
      await postVoucher(owner, {
        ref,
        date: new Date(),
        description: "برگشت از فروش (برگ اعتباری)",
        source: { type: "request", id: r._id },
        lines: [
          { role: "incomeReturns", label: `برگشت ${r.invoiceRef || ""} ${r.description || ""}`.trim(), debit: r.amount },
          { role: "receivable", party: r.party, label, credit: r.amount },
        ],
        createdBy: by,
      });
      return { ref };
    }
    case "invoice": {
      const inv = await issueInvoice(owner, String(r.invoice), by);
      return { ref: `inv:${(inv as { _id: unknown })._id}` };
    }
  }
  return {};
};

export const cancelRequest = async (owner: BizOwner, id: string, by: unknown, isOwner: boolean) => {
  const r = await BizRequest.findOne({ ...ownerFilter(owner), _id: id });
  if (!r) throw new AppError("درخواست پیدا نشد", 404);
  if (r.status === "done" || r.status === "cancelled") throw new AppError("این درخواست دیگر لغو نمی‌شود", 400);
  if (!isOwner && String(r.requester) !== String(by)) throw new AppError("فقط ثبت‌کننده یا مالک درخواست را لغو می‌کند", 403);
  r.status = "cancelled";
  await r.save();
  return r.toObject();
};

export const listRequests = async (owner: BizOwner, q: { kind?: string; status?: string; mine?: boolean; by?: unknown }) => {
  const filter: Record<string, unknown> = { ...ownerFilter(owner) };
  if (q.kind && bizRequestKinds.includes(q.kind as BizRequestKind)) filter.kind = q.kind;
  if (q.status) filter.status = q.status;
  const items = await BizRequest.find(filter).sort({ createdAt: -1 }).limit(300).lean<IBizRequest[]>();
  const counts = await BizRequest.aggregate([{ $match: { ...ownerFilter(owner), status: { $in: ["pending", "approved"] } } }, { $group: { _id: { kind: "$kind", status: "$status" }, n: { $sum: 1 } } }]);
  const by = q.by ? String(q.by) : "";
  return {
    items: items.map((r) => ({ ...r, myTurn: r.status === "pending" && String(r.chain[r.level] || "") === by })),
    counts: counts.map((c) => ({ kind: c._id.kind, status: c._id.status, n: c.n })),
  };
};
