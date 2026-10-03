import mongoose from "mongoose";
import BizAccount, { BizAccountType, BizOwnerKind, IBizAccount } from "../../Models/BizAccount";
import { Locale, SOURCE_LOCALE } from "../locales";
import { coaNameTranslations } from "./coaNames";

// The healthcare chart of accounts (2026-10). Codes follow the Iranian
// standard coding of nexxacrm's "service" template (lib/coaTemplates.ts:
// 1 current assets, 2 non-current assets, 3 liabilities, 5 equity,
// 6 income, 7 expenses), trimmed to what a provider uses and given the
// accounts only a health platform needs: the balance held in the Noyan
// wallet, earnings still in their settlement hold, the platform fee. Every
// system account has a role; automatic vouchers post to roles, so a
// provider may rename an account without breaking them.

type Tpl = {
  code: string;
  name: string;
  type: BizAccountType;
  level: "group" | "total" | "detail";
  parent?: string;
  role?: string;
  // the owner kinds that get it; omitted = every kind
  only?: BizOwnerKind[];
  not?: BizOwnerKind[];
};

const P: BizOwnerKind[] = ["doctor", "clinic", "hospital", "pharmacy", "paraClinic", "insurance"];
const STOCK: BizOwnerKind[] = ["pharmacy", "paraClinic", "clinic", "hospital"];

export const COA_TEMPLATE: Tpl[] = [
  { code: "1", name: "دارایی‌های جاری", type: "asset", level: "group" },
  { code: "11", name: "موجودی نقد", type: "asset", level: "total", parent: "1" },
  { code: "1101", name: "صندوق", type: "asset", level: "detail", parent: "11", role: "cash" },
  { code: "1102", name: "بانک", type: "asset", level: "detail", parent: "11", role: "bank" },
  { code: "1105", name: "حساب نزد نویان (کیف پول)", type: "asset", level: "detail", parent: "11", role: "noyanWallet", only: P },
  { code: "1106", name: "مطالبات در دوره‌ی تسویه‌ی نویان", type: "asset", level: "detail", parent: "11", role: "noyanPending", only: P },
  { code: "1107", name: "برداشت در راه", type: "asset", level: "detail", parent: "11", role: "withdrawalTransit", only: P },
  { code: "14", name: "حساب‌های دریافتنی", type: "asset", level: "total", parent: "1" },
  { code: "1411", name: "بدهکاران (بیماران و مشتریان)", type: "asset", level: "detail", parent: "14", role: "receivable" },
  { code: "1412", name: "مطالبات از بیمه‌ها", type: "asset", level: "detail", parent: "14", role: "insuranceReceivable", not: ["insurance", "platform"] },
  { code: "1413", name: "مساعده و وام کارکنان", type: "asset", level: "detail", parent: "14", role: "employeeAdvances", not: ["platform"] },
  { code: "16", name: "موجودی کالا", type: "asset", level: "total", parent: "1", only: STOCK },
  { code: "1601", name: "موجودی دارو و کالا", type: "asset", level: "detail", parent: "16", role: "inventory", only: STOCK },
  { code: "1602", name: "موجودی ملزومات مصرفی پزشکی", type: "asset", level: "detail", parent: "16", role: "supplies", only: STOCK },
  { code: "15", name: "سایر حساب‌های دریافتنی", type: "asset", level: "total", parent: "1", not: ["platform"] },
  { code: "1510", name: "مالیات بر ارزش افزوده‌ی خرید", type: "asset", level: "detail", parent: "15", role: "vatReceivable", not: ["platform"] },
  { code: "18", name: "پیش‌پرداخت‌ها", type: "asset", level: "total", parent: "1" },
  { code: "1801", name: "پیش‌پرداخت‌ها", type: "asset", level: "detail", parent: "18", role: "prepaid" },

  { code: "2", name: "دارایی‌های غیرجاری", type: "asset", level: "group" },
  { code: "25", name: "دارایی‌های ثابت", type: "asset", level: "total", parent: "2" },
  { code: "2501", name: "تجهیزات پزشکی", type: "asset", level: "detail", parent: "25", role: "equipment", not: ["platform", "insurance"] },
  { code: "2502", name: "اثاثیه و منصوبات", type: "asset", level: "detail", parent: "25", role: "furniture" },
  { code: "2522", name: "استهلاک انباشته", type: "asset", level: "detail", parent: "25", role: "accumulatedDepreciation" },

  { code: "3", name: "بدهی‌های جاری", type: "liability", level: "group" },
  { code: "32", name: "حساب‌های پرداختنی", type: "liability", level: "total", parent: "3" },
  { code: "3201", name: "بستانکاران و تأمین‌کنندگان", type: "liability", level: "detail", parent: "32", role: "payable" },
  { code: "33", name: "سایر حساب‌های پرداختنی", type: "liability", level: "total", parent: "3" },
  { code: "3303", name: "حقوق پرداختنی", type: "liability", level: "detail", parent: "33", role: "salaryPayable" },
  { code: "3304", name: "بیمه و مالیات حقوق پرداختنی", type: "liability", level: "detail", parent: "33", role: "payrollTaxPayable" },
  { code: "3307", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", level: "detail", parent: "33", role: "vatPayable" },
  { code: "34", name: "بدهی به کاربران و ارائه‌دهندگان", type: "liability", level: "total", parent: "3", only: ["platform"] },
  { code: "3401", name: "کیف پول کاربران", type: "liability", level: "detail", parent: "34", role: "userWallets", only: ["platform"] },
  { code: "3402", name: "بدهی به ارائه‌دهندگان در دوره‌ی تسویه", type: "liability", level: "detail", parent: "34", role: "providerPending", only: ["platform"] },
  { code: "3403", name: "پیش‌دریافت نوبت‌ها و سفارش‌ها", type: "liability", level: "detail", parent: "34", role: "unearned", only: ["platform"] },
  { code: "3404", name: "برداشت‌های در حال پرداخت", type: "liability", level: "detail", parent: "34", role: "withdrawalsInTransit", only: ["platform"] },

  { code: "5", name: "حقوق صاحبان سرمایه", type: "equity", level: "group" },
  { code: "51", name: "سرمایه", type: "equity", level: "total", parent: "5" },
  { code: "5101", name: "سرمایه", type: "equity", level: "detail", parent: "51", role: "capital" },
  { code: "5102", name: "برداشت مالک", type: "equity", level: "detail", parent: "51", role: "ownerDrawings", not: ["platform"] },
  { code: "5103", name: "تراز افتتاحیه", type: "equity", level: "detail", parent: "51", role: "openingBalance" },
  { code: "58", name: "سود و زیان انباشته", type: "equity", level: "total", parent: "5" },
  { code: "5801", name: "سود و زیان انباشته", type: "equity", level: "detail", parent: "58", role: "retainedEarnings" },

  { code: "6", name: "درآمدها", type: "income", level: "group" },
  { code: "61", name: "درآمدهای عملیاتی", type: "income", level: "total", parent: "6" },
  { code: "6101", name: "درآمد ویزیت", type: "income", level: "detail", parent: "61", role: "visitIncome", only: ["doctor", "clinic", "hospital"] },
  { code: "6102", name: "درآمد خدمات و بسته‌های درمانی", type: "income", level: "detail", parent: "61", role: "serviceIncome", only: ["doctor", "clinic", "hospital"] },
  { code: "6103", name: "درآمد فروش دارو و کالا", type: "income", level: "detail", parent: "61", role: "salesIncome", only: ["pharmacy", "doctor"] },
  { code: "6104", name: "درآمد آزمایش و تصویربرداری", type: "income", level: "detail", parent: "61", role: "testIncome", only: ["paraClinic", "clinic", "hospital"] },
  { code: "6105", name: "درآمد بستری و اعمال جراحی", type: "income", level: "detail", parent: "61", role: "inpatientIncome", only: ["hospital"] },
  { code: "6106", name: "درآمد حق بیمه", type: "income", level: "detail", parent: "61", role: "premiumIncome", only: ["insurance"] },
  { code: "6107", name: "درآمد ارسال", type: "income", level: "detail", parent: "61", role: "shippingIncome", only: ["pharmacy"] },
  { code: "6110", name: "درآمد کارمزد (کمیسیون)", type: "income", level: "detail", parent: "61", role: "commissionIncome", only: ["platform"] },
  { code: "6111", name: "درآمد فروش اشتراک", type: "income", level: "detail", parent: "61", role: "subscriptionIncome", only: ["platform"] },
  { code: "6201", name: "برگشت و تخفیفات درآمد", type: "income", level: "detail", parent: "61", role: "incomeReturns", not: ["platform"] },
  { code: "69", name: "سایر درآمدها", type: "income", level: "total", parent: "6" },
  { code: "6901", name: "سایر درآمدها", type: "income", level: "detail", parent: "69", role: "otherIncome" },

  { code: "7", name: "هزینه‌ها", type: "expense", level: "group" },
  { code: "71", name: "هزینه‌های پرسنلی", type: "expense", level: "total", parent: "7" },
  { code: "7101", name: "حقوق و دستمزد", type: "expense", level: "detail", parent: "71", role: "salaryExpense" },
  { code: "7102", name: "بیمه‌ی سهم کارفرما", type: "expense", level: "detail", parent: "71", role: "employerInsurance" },
  { code: "72", name: "هزینه‌های عمومی و اداری", type: "expense", level: "total", parent: "7" },
  { code: "7201", name: "اجاره", type: "expense", level: "detail", parent: "72", role: "rent" },
  { code: "7202", name: "آب، برق، گاز و تلفن", type: "expense", level: "detail", parent: "72", role: "utilities" },
  { code: "7203", name: "ملزومات مصرفی پزشکی", type: "expense", level: "detail", parent: "72", role: "suppliesExpense", not: ["platform", "insurance"] },
  { code: "7204", name: "کارمزد پلتفرم نویان", type: "expense", level: "detail", parent: "72", role: "platformFee", only: P },
  { code: "7205", name: "اشتراک نرم‌افزار (پلن نویان)", type: "expense", level: "detail", parent: "72", role: "subscriptionExpense", only: P },
  { code: "7206", name: "تبلیغات و بازاریابی", type: "expense", level: "detail", parent: "72", role: "marketing" },
  { code: "7207", name: "تعمیر و نگهداری تجهیزات", type: "expense", level: "detail", parent: "72", role: "maintenance" },
  { code: "7208", name: "کارمزد بانکی و درگاه", type: "expense", level: "detail", parent: "72", role: "bankFees" },
  { code: "7209", name: "هزینه‌ی پیامک و ارتباطات", type: "expense", level: "detail", parent: "72", role: "smsExpense" },
  { code: "7213", name: "هزینه‌ی استهلاک", type: "expense", level: "detail", parent: "72", role: "depreciation" },
  { code: "7214", name: "کسری و اضافات انبار", type: "expense", level: "detail", parent: "72", role: "inventoryVariance", only: STOCK },
  { code: "7299", name: "سایر هزینه‌ها", type: "expense", level: "detail", parent: "72", role: "otherExpense" },
  { code: "73", name: "بهای تمام‌شده", type: "expense", level: "total", parent: "7", not: ["platform", "insurance"] },
  { code: "7301", name: "بهای تمام‌شده‌ی کالای فروش‌رفته", type: "expense", level: "detail", parent: "73", role: "cogs", not: ["platform", "insurance"] },
];

const appliesTo = (t: Tpl, kind: BizOwnerKind) =>
  (!t.only || t.only.includes(kind)) && (!t.not || !t.not.includes(kind));

export type BizOwner = { kind: BizOwnerKind; id?: mongoose.Types.ObjectId | string | null };

export const ownerFilter = (owner: BizOwner) => ({
  ownerKind: owner.kind,
  ownerId: owner.kind === "platform" || !owner.id ? { $exists: false } : new mongoose.Types.ObjectId(String(owner.id)),
});

const ownerFields = (owner: BizOwner) =>
  owner.kind === "platform" || !owner.id
    ? { ownerKind: owner.kind }
    : { ownerKind: owner.kind, ownerId: new mongoose.Types.ObjectId(String(owner.id)) };

const seeded = new Set<string>();
const ownerKey = (owner: BizOwner) => `${owner.kind}:${owner.id || ""}`;

// Creates the chart for an owner the first time its books are touched
// (idempotent; existing accounts, renamed or not, are kept).
export const ensureChart = async (owner: BizOwner) => {
  const key = ownerKey(owner);
  if (seeded.has(key)) return;
  const have = await BizAccount.find(ownerFilter(owner)).select("code").lean();
  const codes = new Set(have.map((a) => a.code));
  const missing = COA_TEMPLATE.filter((t) => appliesTo(t, owner.kind) && !codes.has(t.code));
  if (missing.length)
    await BizAccount.insertMany(
      missing.map((t) => ({
        ...ownerFields(owner),
        code: t.code,
        name: t.name,
        type: t.type,
        level: t.level,
        parentCode: t.parent,
        role: t.role,
      })),
      { ordered: false },
    ).catch((err) => {
      // a concurrent first touch inserted the same codes: fine
      if (err?.code !== 11000 && !err?.writeErrors) throw err;
    });
  seeded.add(key);
};

const accountCache = new Map<string, IBizAccount>();

// The account a system role posts to.
export const accountFor = async (owner: BizOwner, role: string): Promise<IBizAccount> => {
  const key = `${ownerKey(owner)}:${role}`;
  const hit = accountCache.get(key);
  if (hit) return hit;
  await ensureChart(owner);
  const acc = await BizAccount.findOne({ ...ownerFilter(owner), role }).lean<IBizAccount>();
  if (!acc) throw new Error(`[business] ${owner.kind} has no account for role ${role}`);
  accountCache.set(key, acc);
  return acc;
};

export const clearAccountCache = () => accountCache.clear();

// A system account still carrying its template name is shown in the
// reader's language; a name the owner typed is shown as typed.
export const displayName = (acc: Pick<IBizAccount, "name" | "code" | "role">, locale: Locale) => {
  if (locale === SOURCE_LOCALE) return acc.name;
  const tpl = COA_TEMPLATE.find((t) => t.code === acc.code);
  if (!tpl || tpl.name !== acc.name) return acc.name;
  return coaNameTranslations[tpl.name]?.[locale] || acc.name;
};

// income/expense/asset sides: an account's natural balance
export const natural = (type: BizAccountType, debit: number, credit: number) =>
  type === "asset" || type === "expense" ? debit - credit : credit - debit;
