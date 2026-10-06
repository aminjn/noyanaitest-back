// Tools every organisation profile has (where its plan and ACL allow):
// pages, CRM (Nexxa's CRM copilot ported), finance, inventory, claims,
// payroll and call analysis. Reads run the normal endpoint handler
// in-process with the user's own request; writes return a confirmation
// card for the normal endpoint.
import { z } from "zod";
import { makeCrmController } from "../../../../Controllers/crmController";
import { makeCrmEngageController } from "../../../../Controllers/crmEngageController";
import { makeFinanceController } from "../../../../Controllers/financeSuiteController";
import { makeInventoryController } from "../../../../Controllers/inventoryController";
import { makePayrollController } from "../../../../Controllers/payrollController";
import { ownerOfReq } from "../../../../Controllers/businessController";
import { contactInsight, crmActionPlan, crmTemplateText } from "../../../../Services/panelAiFeatures";
import { NodeWithAcl } from "../../../enums";
import { PROFILES } from "../profiles";
import { invoke, registerCopilotTool } from "../registry";
import { Card, CardRow, ORG_PROFILES, Profile, ToolCtx, txt } from "../types";
import { asArray, count, dateText, isYmd, money, summarize, ymd, statusTxt } from "./helpers";

const ORGS = ORG_PROFILES as Profile[];
const STOCK_ORGS: Profile[] = ["clinic", "hospital", "pharmacy", "paraClinic"];
const BILLING_ORGS: Profile[] = ["doctor", "clinic", "hospital", "pharmacy", "paraClinic"];

const kind = (ctx: ToolCtx) => ctx.profile as NodeWithAcl;
const crm = (ctx: ToolCtx) => makeCrmController(ownerOfReq(kind(ctx)));
const engage = (ctx: ToolCtx) => makeCrmEngageController(ownerOfReq(kind(ctx)));
const fin = (ctx: ToolCtx) => makeFinanceController(ownerOfReq(kind(ctx)));
const inv = (ctx: ToolCtx) => makeInventoryController(ownerOfReq(kind(ctx)));
const pay = (ctx: ToolCtx) => makePayrollController(ownerOfReq(kind(ctx)));
const q = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 100) : "");

type Contact = { _id: string; name: string; phone: string; visits?: number; lastVisitAt?: string; tags?: string[] };
const findContacts = async (ctx: ToolCtx, query: string, limit = 6) => {
  const data = await invoke<{ items?: Contact[] }>(crm(ctx).getContacts, ctx.req, {
    query: { ...(query ? { q: query } : {}), limit: String(limit), page: "1", sort: "recent" },
  });
  return asArray<Contact>(data?.items);
};

// ---------------- pages ----------------

registerCopilotTool({
  name: "navigate",
  profiles: [...ORGS, "user", "admin"],
  kind: "navigate",
  description: "Open a page of this panel. `page` is one of the page keys listed under PAGES.",
  args: '{"page": string}',
  schema: z.object({ page: z.string().max(60) }),
  run: async (ctx, args) => {
    const page = PROFILES[ctx.profile].pages.find((p) => p.key === args.page);
    if (!page) return { type: "message", text: txt("copPageUnknown", "این صفحه را پیدا نکردم") };
    const path = page.path.startsWith("/") ? page.path : `${ctx.panel}${page.path ? `/${page.path}` : ""}`;
    return { type: "navigate", path };
  },
});

// ---------------- CRM ----------------

registerCopilotTool({
  name: "crm_find_contact",
  profiles: ORGS,
  kind: "read",
  description: "Find patients / customers in the CRM by name or phone.",
  args: '{"query": string}',
  schema: z.object({ query: z.string().max(100) }),
  acl: "readCrm",
  module: "crm",
  run: async (ctx, args) => {
    const rows = await findContacts(ctx, q(args.query), 8);
    return {
      type: "list",
      title: txt("copContactsFound", "بیماران و مشتریان پیدا شده"),
      rows: rows.map((c) => ({
        title: c.name || c.phone,
        sub: [c.phone, c.lastVisitAt ? dateText(c.lastVisitAt) : ""].filter(Boolean).join(" · "),
        link: `${ctx.panel}/crm/contacts/${c._id}`,
      })),
      empty: txt("copNothingFound", "چیزی پیدا نشد"),
      link: `${ctx.panel}/crm/contacts`,
    };
  },
});

registerCopilotTool({
  name: "crm_followups_due",
  profiles: ORGS,
  kind: "read",
  description: "List the open follow-up tasks that are due (overdue, today or this week).",
  args: '{"due": "overdue"|"today"|"week"}',
  schema: z.object({ due: z.enum(["overdue", "today", "week"]).optional() }),
  acl: "readCrm",
  module: "crm",
  run: async (ctx, args) => {
    const rows = asArray<{ _id: string; text: string; dueAt?: string; contact?: { _id?: string; name?: string; phone?: string } }>(
      await invoke(engage(ctx).getFollowUps, ctx.req, { query: { status: "open", due: (args.due as string) || "week" } }),
    );
    return {
      type: "list",
      title: txt("copFollowUpsDue", "پیگیری‌های سررسید"),
      rows: rows.slice(0, 12).map((a) => ({
        title: a.contact?.name || a.contact?.phone || "",
        sub: `${a.text}${a.dueAt ? ` · ${dateText(a.dueAt)}` : ""}`,
        badge: a.dueAt && new Date(a.dueAt) < new Date(new Date().setHours(0, 0, 0, 0)) ? txt("copOverdue", "گذشته") : undefined,
        link: a.contact?._id ? `${ctx.panel}/crm/contacts/${a.contact._id}` : undefined,
      })),
      empty: txt("copNoFollowUps", "پیگیری سررسیده‌ای نیست"),
      link: `${ctx.panel}/crm/followups`,
    };
  },
});

registerCopilotTool({
  name: "crm_create_followup",
  profiles: ORGS,
  kind: "write",
  description: "Prepare a follow-up task (a call or reminder) for a CRM contact on a date.",
  args: '{"contact": string (name or phone), "text": string, "dueDate": "YYYY-MM-DD"}',
  schema: z.object({ contact: z.string().max(100).optional(), text: z.string().max(1000).optional(), dueDate: z.string().max(10).optional() }),
  acl: "manageCrm",
  module: "crm",
  run: async (ctx, args) => {
    const rows = await findContacts(ctx, q(args.contact), 8);
    return {
      type: "confirm",
      title: txt("copNewFollowUp", "پیگیری تازه"),
      fields: [
        {
          key: "contact",
          label: txt("copFieldContact", "بیمار / مشتری"),
          type: "select",
          required: true,
          value: rows[0]?._id || "",
          options: rows.map((c) => ({ value: c._id, label: `${c.name} · ${c.phone}` })),
        },
        { key: "text", label: txt("copFieldTask", "کار پیگیری"), type: "textarea", required: true, value: String(args.text || "") },
        {
          key: "dueAt",
          label: txt("copFieldDueDate", "تاریخ پیگیری"),
          type: "date",
          required: true,
          value: isYmd(args.dueDate) ? args.dueDate : ymd(new Date(Date.now() + 864e5)),
        },
      ],
      request: { method: "POST", path: `${ctx.api}/crm/followups` },
      link: `${ctx.panel}/crm/followups`,
      done: txt("copFollowUpSaved", "پیگیری ثبت شد"),
    };
  },
});

registerCopilotTool({
  name: "crm_draft_template",
  aiFeature: "crm.template",
  profiles: ORGS,
  kind: "write",
  description: "Write an SMS template for a goal (recall, thanks, birthday, no-show, win-back, chronic care, or general) and prepare it for saving.",
  args: '{"goal": string}',
  schema: z.object({ goal: z.string().min(2).max(600) }),
  acl: "manageCrm",
  module: "crm",
  run: async (ctx, args) => {
    const org = (ctx.req as unknown as Record<string, { name?: string; firstName?: string; lastName?: string } | undefined>)[ctx.profile];
    const orgName = org?.name || [org?.firstName, org?.lastName].filter(Boolean).join(" ") || "";
    const t = await crmTemplateText(String(args.goal), orgName);
    return {
      type: "confirm",
      title: txt("copNewTemplate", "قالب پیامک تازه"),
      text: undefined,
      fields: [
        { key: "name", label: txt("copFieldName", "نام"), type: "text", required: true, value: t.name },
        {
          key: "category",
          label: txt("copFieldCategory", "دسته"),
          type: "select",
          value: t.category,
          options: ["general", "recall", "thanks", "birthday", "noShow", "winback", "chronic"].map((c) => ({ value: c, label: statusTxt("copTplCat", c) })),
        },
        { key: "text", label: txt("copFieldSms", "متن پیامک"), type: "textarea", required: true, value: t.text },
      ],
      request: { method: "POST", path: `${ctx.api}/crm/templates` },
      link: `${ctx.panel}/crm/templates`,
      done: txt("copTemplateSaved", "قالب به‌صورت پیش‌نویس ذخیره شد"),
    };
  },
});

registerCopilotTool({
  name: "crm_action_plan",
  aiFeature: "crm.plan",
  profiles: ORGS,
  kind: "read",
  description: "Today's patient-relations action plan: overdue follow-ups, no-shows to call back, recall candidates.",
  acl: "readCrm",
  module: "crm",
  run: async (ctx) => {
    const p = await crmActionPlan(ctx.owner!);
    return {
      type: "insight",
      title: txt("copActionPlan", "برنامه‌ی اقدام امروز"),
      text: [p.plan, ...p.actions.map((a) => `• ${a}`)].filter(Boolean).join("\n"),
      link: `${ctx.panel}/crm/followups`,
    };
  },
});

registerCopilotTool({
  name: "crm_contact_insight",
  aiFeature: "crm.contactInsight",
  profiles: ORGS,
  kind: "read",
  description: "Summarize one CRM contact's relationship and draft a follow-up message.",
  args: '{"contact": string (name or phone)}',
  schema: z.object({ contact: z.string().min(1).max(100) }),
  acl: "readCrm",
  module: "crm",
  run: async (ctx, args) => {
    const rows = await findContacts(ctx, q(args.contact), 3);
    if (!rows.length) return { type: "message", text: txt("copNothingFound", "چیزی پیدا نشد") };
    const r = await contactInsight(ctx.owner!, rows[0]._id);
    if (!r) return { type: "message", text: txt("copNothingFound", "چیزی پیدا نشد") };
    return {
      type: "insight",
      title: txt("copContactInsight", "نگاه به پرونده‌ی ${1}", [r.contact.name]),
      text: [r.summary, r.nextAction && `→ ${r.nextAction}`, r.message && `✉ ${r.message}`].filter(Boolean).join("\n\n"),
      link: `${ctx.panel}/crm/contacts/${r.contact._id}`,
    };
  },
});

// ---------------- finance ----------------

registerCopilotTool({
  name: "finance_overview",
  profiles: ORGS,
  kind: "read",
  description: "Summarize the finances: this month's income and expenses, cash and bank, receivables, payables, open invoices and claims.",
  acl: "readFinance",
  module: "accounting",
  run: async (ctx) => {
    const o = await invoke<Record<string, unknown>>(fin(ctx).overview, ctx.req);
    const data = {
      month: o?.month,
      year: o?.year,
      cash: o?.cash,
      bank: o?.bank,
      receivables: o?.receivables,
      payables: o?.payables,
      open: o?.open,
      wallet: o?.wallet,
      cheques: { overdue: (o?.cheques as Record<string, unknown>)?.overdue, bounced: (o?.cheques as Record<string, unknown>)?.bounced },
    };
    const text = await summarize(ctx, "Summarize this practice's finances for its manager; amounts are in toman. Point out what needs attention.", data);
    const m = (o?.month || {}) as { income?: number; expense?: number; profit?: number };
    return {
      type: "insight",
      title: txt("copFinanceTitle", "مالی"),
      text,
      rows: [
        { title: money(m.income), sub: "", badge: txt("copMonthIncome", "درآمد این ماه") },
        { title: money(m.expense), sub: "", badge: txt("copMonthExpense", "هزینه‌ی این ماه") },
        { title: money(Number(o?.cash || 0) + Number(o?.bank || 0)), sub: "", badge: txt("copCashBank", "نقد و بانک") },
      ],
      link: `${ctx.panel}/finance`,
    };
  },
});

registerCopilotTool({
  name: "finance_draft_expense",
  profiles: ORGS,
  kind: "write",
  description: "Prepare an expense entry (rent, supplies, salaries are not here) with amount, description, vendor and date.",
  args: '{"amount": number (toman), "description": string, "vendor": string, "date": "YYYY-MM-DD", "accountHint": string}',
  schema: z.object({
    amount: z.union([z.number(), z.string()]).optional(),
    description: z.string().max(500).optional(),
    vendor: z.string().max(200).optional(),
    date: z.string().max(10).optional(),
    accountHint: z.string().max(100).optional(),
  }),
  acl: "manageAccounting",
  module: "accounting",
  run: async (ctx, args) => {
    const accounts = asArray<{ _id: string; name: string; code?: string }>(await invoke(fin(ctx).expenseAccounts, ctx.req));
    const hint = String(args.accountHint || args.description || "").trim();
    const guess = hint ? accounts.find((a) => hint.includes(a.name) || a.name.includes(hint.split(/\s+/)[0] || "\u0000")) : undefined;
    return {
      type: "confirm",
      title: txt("copNewExpense", "ثبت هزینه"),
      fields: [
        {
          key: "account",
          label: txt("copFieldExpenseKind", "نوع هزینه"),
          type: "select",
          required: true,
          value: guess?._id || "",
          options: accounts.map((a) => ({ value: a._id, label: a.name })),
        },
        { key: "amount", label: txt("copFieldAmount", "مبلغ (تومان)"), type: "number", required: true, value: Number(String(args.amount ?? "").replace(/[^\d.]/g, "")) || "" },
        { key: "description", label: txt("copFieldDescription", "شرح"), type: "text", value: String(args.description || "") },
        { key: "vendor", label: txt("copFieldVendor", "طرف حساب"), type: "text", value: String(args.vendor || "") },
        { key: "date", label: txt("copFieldDate", "تاریخ"), type: "date", value: isYmd(args.date) ? args.date : ymd() },
      ],
      request: { method: "POST", path: `${ctx.api}/biz/finance/expenses` },
      link: `${ctx.panel}/finance/expenses`,
      done: txt("copExpenseSaved", "هزینه ثبت شد"),
    };
  },
});

registerCopilotTool({
  name: "insurance_claims",
  profiles: BILLING_ORGS,
  kind: "read",
  description: "The insurance claims sent to insurers: open ones, their aging, and the insurer shares not yet claimed.",
  args: '{"status": "open"|"draft"|"paid"|"rejected"}',
  schema: z.object({ status: z.string().max(20).optional() }),
  acl: "readFinance",
  module: "accounting",
  run: async (ctx, args) => {
    const d = await invoke<{ items?: { _id: string; number: number; insurer?: { name?: string }; claimed: number; paid: number; deducted: number; status: string; submittedAt?: string }[]; aging?: Record<string, number>; unclaimed?: { amount: number; count: number } }>(
      fin(ctx).listClaims,
      ctx.req,
      { query: args.status ? { status: String(args.status) } : { status: "open" } },
    );
    const items = asArray<NonNullable<typeof d.items>[number]>(d?.items);
    return {
      type: "list",
      title: txt("copClaims", "لیست‌های بیمه"),
      text: d?.unclaimed?.count
        ? `${count(d.unclaimed.count)} · ${money(d.unclaimed.amount)}`
        : undefined,
      rows: items.slice(0, 10).map((c) => ({
        title: `#${c.number} · ${c.insurer?.name || ""}`,
        sub: `${money(c.claimed - c.paid - c.deducted)} / ${money(c.claimed)}${c.submittedAt ? ` · ${dateText(c.submittedAt)}` : ""}`,
        badge: statusTxt("copClaim", c.status),
      })),
      empty: txt("copNothingFound", "چیزی پیدا نشد"),
      link: `${ctx.panel}/finance/insurance`,
    };
  },
});

registerCopilotTool({
  name: "payroll_status",
  profiles: ORGS,
  kind: "read",
  description: "The payroll: the latest monthly pay runs and whether they are posted and paid.",
  acl: "readPayroll",
  module: "payroll",
  run: async (ctx) => {
    const d = await invoke<{ runs?: { _id: string; year: number; month: number; status?: string; totals?: Record<string, number> }[] }>(pay(ctx).getRuns, ctx.req);
    const runs = asArray<NonNullable<typeof d.runs>[number]>(d?.runs);
    return {
      type: "list",
      title: txt("copPayroll", "حقوق و دستمزد"),
      rows: runs.slice(0, 6).map((r) => ({
        title: `${r.year}/${String(r.month).padStart(2, "0")}`,
        sub: r.totals ? Object.entries(r.totals).slice(0, 2).map(([, v]) => money(v)).join(" · ") : "",
        badge: r.status ? statusTxt("copRun", r.status) : undefined,
      })),
      empty: txt("copNoPayroll", "هنوز لیست حقوقی ساخته نشده"),
      link: `${ctx.panel}/finance/payroll`,
    };
  },
});

// ---------------- inventory ----------------

type Item = { _id: string; name: string; unit?: string; stock: number; value: number; nextExpiry?: string | null; expiredQty: number; nearQty: number; suggested: number; low: boolean; monthlyDemand: number };
const items = async (ctx: ToolCtx) => asArray<Item>(await invoke(inv(ctx).getItems, ctx.req));

registerCopilotTool({
  name: "inventory_alerts",
  profiles: STOCK_ORGS,
  kind: "read",
  description: "Stock alerts: items at or below the reorder point, expired or near-expiry batches, and suggested reorder quantities.",
  acl: "readInventory",
  module: "inventory",
  run: async (ctx) => {
    const all = await items(ctx);
    const rows: CardRow[] = [];
    for (const i of all) {
      if (i.expiredQty > 0) rows.push({ title: i.name, sub: `${count(i.expiredQty)} ${i.unit || ""}`, badge: txt("copExpired", "تاریخ گذشته") });
      else if (i.nearQty > 0) rows.push({ title: i.name, sub: `${count(i.nearQty)} ${i.unit || ""} · ${dateText(i.nextExpiry)}`, badge: txt("copNearExpiry", "نزدیک به انقضا") });
      if (i.low || i.suggested > 0)
        rows.push({ title: i.name, sub: `${count(i.stock)} → +${count(i.suggested)} ${i.unit || ""}`, badge: txt("copReorder", "سفارش دوباره") });
    }
    return {
      type: "list",
      title: txt("copStockAlerts", "هشدارهای انبار"),
      rows: rows.slice(0, 15),
      empty: txt("copStockOk", "موجودی و تاریخ انقضا مشکلی ندارد"),
      link: `${ctx.panel}/finance/inventory`,
    };
  },
});

registerCopilotTool({
  name: "purchase_draft",
  profiles: STOCK_ORGS,
  kind: "write",
  description: "Prepare a purchase order to a distributor / supplier from the reorder suggestions.",
  args: '{"supplier": string (name, optional)}',
  schema: z.object({ supplier: z.string().max(100).optional() }),
  acl: "manageInventory",
  module: "inventory",
  run: async (ctx, args) => {
    const [all, suppliers] = await Promise.all([
      items(ctx),
      invoke<{ _id: string; name: string }[]>(inv(ctx).getSuppliers, ctx.req).then((d) => asArray<{ _id: string; name: string }>(d)),
    ]);
    const want = all.filter((i) => i.suggested > 0).slice(0, 30);
    if (!want.length) return { type: "message", text: txt("copNothingToReorder", "فعلاً کالایی برای سفارش پیشنهاد نمی‌شود") };
    const s = String(args.supplier || "");
    const supplier = (s && suppliers.find((x) => x.name.includes(s) || s.includes(x.name))) || suppliers[0];
    return {
      type: "confirm",
      title: txt("copNewPurchase", "سفارش خرید"),
      fields: [
        {
          key: "supplier",
          label: txt("copFieldSupplier", "تأمین‌کننده"),
          type: "select",
          required: true,
          value: supplier?._id || "",
          options: suppliers.map((x) => ({ value: x._id, label: x.name })),
        },
        { key: "date", label: txt("copFieldDate", "تاریخ"), type: "date", value: ymd() },
        {
          key: "lines",
          label: txt("copFieldLines", "اقلام"),
          type: "lines",
          value: want.map((i) => ({
            item: i._id,
            label: i.name,
            qty: i.suggested,
            unitCost: i.stock > 0 ? Math.round(i.value / i.stock) : 0,
          })),
        },
      ],
      request: { method: "POST", path: `${ctx.api}/inv/purchases` },
      link: `${ctx.panel}/finance/inventory`,
      done: txt("copPurchaseSaved", "سفارش خرید ثبت شد"),
    };
  },
});

// ---------------- calls ----------------

registerCopilotTool({
  name: "call_analyze",
  // the uploader card; the upload counts it (/ai/:name/call/analyze)
  aiFeature: "crm.callAnalysis",
  aiCounted: true,
  profiles: ORGS,
  kind: "read",
  description: "Analyse a recorded phone call with a patient (upload or record the audio): summary, request, urgency, quality, next action.",
  acl: "readCrm",
  module: "crm",
  run: async () => ({ type: "callAnalyze", title: txt("copCallTitle", "تحلیل تماس تلفنی") }) as Card,
});
