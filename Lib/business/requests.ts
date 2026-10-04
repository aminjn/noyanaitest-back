import mongoose from "mongoose";
import { bizFinanceRequestKinds, BizRequestKind, IBizRequest } from "../../Models/BizRequest";
import BizMoneyAccount, { IBizMoneyAccount } from "../../Models/BizMoneyAccount";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import AppError from "../AppError";
import { accountFor, BizOwner, ownerFilter } from "./coa";
import { postVoucher } from "./voucher";
import { resolveParty } from "./parties";
import { chargePetty, transferFunds, treasuryCredit } from "./treasury";
import { createExpense } from "./expenses";
import { createPayment } from "./payments";
import { issueInvoice } from "./invoices";
import { fileRequest, teamOf } from "./kartabl";
import { createReturn } from "./crmService/returns";

// The finance requests of the panel's «کارتابل» (2026-10), a port of
// Nexxa's petty-cash-requests, expense-requests, payment-requests,
// check-issue-requests, fund-transfers and invoice-approvals with
// lib/request-effects. What each kind needs is checked here before it is
// filed; the chain, the decisions and the once-only apply are the inbox's
// (Lib/business/kartabl.ts). A return is not a finance kind of its own any
// more: the desk files a return (Lib/business/crmService/returns.ts), the one
// flow that books refunds and credit notes.
// Effects:
//   petty        Dr the petty fund / Cr the till or bank (chargePetty)
//   expense      an expense, paid from the till or bank (Lib/business/expenses.ts)
//   payment      Dr the payee's payable / Cr the till or bank
//   checkIssue   an issued cheque to the payee (Dr payable / Cr 3202)
//   fundTransfer Dr the target till / Cr the source (transferFunds)
//   invoice      the draft invoice is issued (Lib/business/invoices.ts)

const FINANCE = bizFinanceRequestKinds;
const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const isId = (v: unknown) => !!v && mongoose.isValidObjectId(String(v));

// the people who may approve: the owner and the team
export const team = teamOf;

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
  // a return: refunded in cash, or a credit note on the receivable
  returnAction?: "refund" | "credit";
  payFrom?: "cash" | "bank";
};

const checkMoney = async (owner: BizOwner, id: unknown, kind?: IBizMoneyAccount["kind"]) => {
  if (!isId(id)) return null;
  const row = await BizMoneyAccount.findOne({ ...ownerFilter(owner), _id: id, ...(kind ? { kind } : {}) }).lean<IBizMoneyAccount>();
  if (!row) throw new AppError("صندوق یا حساب بانکی را انتخاب کنید", 400);
  return row;
};

export const createRequest = async (owner: BizOwner, d: RequestInput, by?: unknown) => {
  if (d.kind === "return") return fileReturn(owner, d, by);
  if (!(FINANCE as readonly string[]).includes(d.kind)) throw new AppError("نوع درخواست نامعتبر است", 400);
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
  return fileRequest(
    owner,
    {
      kind: d.kind,
      approvers: d.approvers,
      amount,
      description: d.description?.trim().slice(0, 500) || undefined,
      money: isId(d.money) ? oid(d.money) : undefined,
      toMoney: isId(d.toMoney) ? oid(d.toMoney) : undefined,
      account: isId(d.account) ? oid(d.account) : undefined,
      center: isId(d.center) ? oid(d.center) : undefined,
      party: party?._id as mongoose.Types.ObjectId | undefined,
      partyName: party?.name || d.partyName?.trim().slice(0, 200) || undefined,
      payKind: d.payKind === "remittance" ? "remittance" : d.kind === "payment" ? "payment" : undefined,
      serial: d.serial?.trim().slice(0, 40) || undefined,
      bank: d.bank?.trim().slice(0, 80) || undefined,
      dueDate: d.dueDate && !Number.isNaN(d.dueDate.getTime()) ? d.dueDate : undefined,
      invoice: isId(d.invoice) ? oid(d.invoice) : undefined,
    },
    by,
  );
};

// a return from the desk: a return of the issued invoice, refunded in cash
// or as a credit note, through the same chain (crmService/returns.ts books it)
const fileReturn = async (owner: BizOwner, d: RequestInput, by?: unknown) => {
  if (!isId(d.invoice)) throw new AppError("صورتحساب را انتخاب کنید", 400);
  const ret = await createReturn(
    owner,
    {
      kind: "service",
      action: d.returnAction === "refund" ? "refund" : "credit",
      invoice: String(d.invoice),
      amount: d.amount,
      payFrom: d.payFrom === "bank" ? "bank" : "cash",
      reason: d.description,
      approvers: (Array.isArray(d.approvers) ? d.approvers : []).map(String),
    },
    by,
  );
  return ret;
};

// the final approval's effect of a finance kind (the inbox runs it once)
export const applyFinanceRequest = async (owner: BizOwner, r: IBizRequest, by?: unknown): Promise<{ ref?: string; payment?: unknown }> => {
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
    case "invoice": {
      const inv = await issueInvoice(owner, String(r.invoice), by);
      return { ref: `inv:${(inv as { _id: unknown })._id}` };
    }
  }
  return {};
};

