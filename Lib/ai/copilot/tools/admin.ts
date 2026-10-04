// The super admin's assistant (/notadmin): platform statistics, the
// provider requests queue (/requests), users and the platform's own books.
// Every tool runs the admin endpoint's own handler, behind the same role
// and AccessLevel checks as its route (see `adminPermission` / `adminOnly`
// in the engine). Texts here are shown through ta() in the admin panel.
import { z } from "zod";
import * as adminDashboardController from "../../../../Controllers/adminDashboardController";
import * as adminRequestsController from "../../../../Controllers/adminRequestsController";
import * as adminUserController from "../../../../Controllers/adminUserController";
import { makeFinanceController } from "../../../../Controllers/financeSuiteController";
import { ownerOfReq } from "../../../../Controllers/businessController";
import { invoke, registerCopilotTool } from "../registry";
import { txt } from "../types";
import { asArray, count, dateText, money, summarize } from "./helpers";

// some admin handlers wrap their payload once more: { data: { data } }
const unwrap = <T>(v: unknown): T => ((v && typeof v === "object" && "data" in (v as object) ? (v as { data: T }).data : v) as T);

registerCopilotTool({
  name: "admin_stats",
  profiles: ["admin"],
  kind: "read",
  description: "Platform statistics: users, providers, reservations, paid orders, commission, pending work, with a short reading.",
  acl: "fullAdmin",
  run: async (ctx) => {
    const d = unwrap<Record<string, unknown>>(await invoke(adminDashboardController.getDashboard, ctx.req));
    const totals = (d?.totals || {}) as Record<string, number>;
    const text = await summarize(
      ctx,
      "Read these healthcare-platform statistics for its operator: what grew, what needs attention (pending work), in short lines.",
      { totals, pending: d?.pending, orders: d?.orders, commission: d?.commissionTotal, reservations: d?.reservations },
    );
    return {
      type: "insight",
      title: txt("copAdminStats", "آمار پلتفرم"),
      text,
      rows: [
        { title: count(totals.users), badge: txt("copUsers", "کاربران") },
        { title: count(totals.doctors), badge: txt("copDoctors", "پزشکان") },
        { title: money(d?.commissionTotal), badge: txt("copCommission", "کارمزد") },
      ],
      link: ctx.panel,
    };
  },
});

registerCopilotTool({
  name: "admin_requests",
  profiles: ["admin"],
  kind: "read",
  description: "The provider requests queue: pending become-provider, membership and addition requests, oldest first.",
  args: '{"kind": string (optional)}',
  schema: z.object({ kind: z.string().max(40).optional() }),
  run: async (ctx, args) => {
    const rows = asArray<{ _id: string; title: string; kind: string; createdAt?: string; detail?: string; applicant?: { phone?: string; name?: string } }>(
      unwrap(await invoke(adminRequestsController.listRequests, ctx.req, { query: { status: "pending", ...(args.kind ? { kind: String(args.kind) } : {}) } })),
    );
    return {
      type: "list",
      title: txt("copAdminRequests", "صف درخواست‌ها"),
      text: count(rows.length),
      rows: rows.slice(0, 12).map((r) => ({
        title: r.title,
        sub: [r.applicant?.name || r.applicant?.phone, dateText(r.createdAt)].filter(Boolean).join(" · "),
        link: r.detail ? `${ctx.panel}${r.detail.startsWith("/") ? r.detail : `/${r.detail}`}` : `${ctx.panel}/requests`,
      })),
      empty: txt("copQueueEmpty", "درخواستی در صف نیست"),
      link: `${ctx.panel}/requests`,
    };
  },
});

registerCopilotTool({
  name: "admin_find_user",
  profiles: ["admin"],
  kind: "read",
  description: "Find users by phone, username or name.",
  args: '{"query": string}',
  schema: z.object({ query: z.string().min(1).max(100) }),
  adminPermission: { model: "User", op: "readAll" },
  run: async (ctx, args) => {
    const d = unwrap<{ items?: { _id: string; phone?: string; username?: string; name?: string; role?: string; status?: string }[] }>(
      await invoke(adminUserController.listUsers, ctx.req, { query: { q: String(args.query), limit: "10", page: "1" } }),
    );
    return {
      type: "list",
      title: txt("copAdminUsers", "کاربران پیدا شده"),
      rows: asArray<NonNullable<typeof d.items>[number]>(d?.items).map((u) => ({
        title: u.name || u.username || u.phone || "",
        sub: [u.phone, u.role, u.status].filter(Boolean).join(" · "),
        link: `${ctx.panel}/user/${u._id}`,
      })),
      empty: txt("copNothingFound", "چیزی پیدا نشد"),
      link: `${ctx.panel}/user`,
    };
  },
});

registerCopilotTool({
  name: "admin_finance",
  profiles: ["admin"],
  kind: "read",
  description: "The platform's own finances: commission income, what is owed to users and providers, VAT, cash.",
  adminPermission: { model: "Finance", op: "readAll" },
  run: async (ctx) => {
    const o = await invoke<Record<string, unknown>>(makeFinanceController(ownerOfReq("platform")).overview, ctx.req);
    const text = await summarize(
      ctx,
      "Summarize the healthcare platform's own books for its operator (amounts in toman): income, payables to providers and users, VAT, cash; what needs attention.",
      { month: o?.month, year: o?.year, cash: o?.cash, bank: o?.bank, receivables: o?.receivables, payables: o?.payables, open: o?.open },
    );
    return { type: "insight", title: txt("copAdminFinance", "مالی پلتفرم"), text, link: `${ctx.panel}/finance` };
  },
});
