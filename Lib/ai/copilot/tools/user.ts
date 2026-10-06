// The patient's assistant in their own dashboard: bookings, the doctor's
// instructions after a visit, orders (and their prescriptions / tests),
// wallet and the Pro membership. Health questions go to the existing AI
// health assistant (/wizard), never answered here. Its requests count
// against the patient's own AI limit (Lib/patientPro.ts: free tier / Pro).
import * as userController from "../../../../Controllers/userController";
import { getMyPatientDashboard } from "../../../../Controllers/patientDashboardController";
import { aiUsageOf, proStatusOf } from "../../../patientPro";
import { invoke, registerCopilotTool } from "../registry";
import { txt } from "../types";
import { asArray, count, dateText, minutesText, money, statusTxt } from "./helpers";

type Doc = { firstName?: string; lastName?: string };
const docName = (d?: Doc) => [d?.firstName, d?.lastName].filter(Boolean).join(" ");

registerCopilotTool({
  name: "my_bookings",
  profiles: ["user"],
  kind: "read",
  description: "My next visits (and the latest one), with the doctor and time.",
  run: async (ctx) => {
    const d = await invoke<{
      next?: { _id: string; date: string; start: number; sessionType: string; doctor?: Doc; intakeFilled?: boolean } | null;
      upcomingCount?: number;
      recentVisits?: { _id: string; date: string; doctor?: Doc; instructions?: string | null }[];
    }>(getMyPatientDashboard, ctx.req);
    const rows = [];
    if (d?.next)
      rows.push({
        title: `${docName(d.next.doctor)} · ${dateText(d.next.date)} ${minutesText(d.next.start)}`,
        sub: "",
        badge: d.next.intakeFilled ? undefined : txt("copIntakeMissing", "پرسش‌نامه‌ی پیش از ویزیت را پر کنید"),
        link: `${ctx.panel}/booking/${d.next._id}`,
      });
    for (const r of asArray<NonNullable<typeof d.recentVisits>[number]>(d?.recentVisits).slice(0, 3))
      rows.push({ title: `${docName(r.doctor)} · ${dateText(r.date)}`, sub: "", badge: txt("copPastVisit", "ویزیت گذشته"), link: `${ctx.panel}/booking/${r._id}` });
    return {
      type: "list",
      title: txt("copMyBookings", "نوبت‌های من"),
      text: d?.upcomingCount ? `${count(d.upcomingCount)}` : undefined,
      rows,
      empty: txt("copNoBookings", "نوبتی ندارید"),
      link: `${ctx.panel}/booking`,
    };
  },
});

registerCopilotTool({
  name: "my_instructions",
  profiles: ["user"],
  kind: "read",
  description: "What my doctors told me after my recent visits (the written instructions).",
  run: async (ctx) => {
    const d = await invoke<{ recentVisits?: { _id: string; date: string; doctor?: Doc; instructions?: string | null }[] }>(getMyPatientDashboard, ctx.req);
    const rows = asArray<NonNullable<typeof d.recentVisits>[number]>(d?.recentVisits)
      .filter((r) => r.instructions)
      .map((r) => ({ title: `${docName(r.doctor)} · ${dateText(r.date)}`, sub: String(r.instructions).slice(0, 400), link: `${ctx.panel}/booking/${r._id}` }));
    return { type: "list", title: txt("copMyInstructions", "توصیه‌های پزشک"), rows, empty: txt("copNoInstructions", "توصیه‌ی ثبت‌شده‌ای ندارید") };
  },
});

registerCopilotTool({
  name: "my_orders",
  profiles: ["user"],
  kind: "read",
  description: "My orders (medicines, products, tests) and their status.",
  run: async (ctx) => {
    type O = { _id: string; status: string; total: number; submittedAt?: string; products?: { item?: { product?: { name?: string } } }[]; tests?: { item?: { test?: { name?: string } } }[] };
    const orders = asArray<O>(await invoke(userController.getMyOrders, ctx.req));
    return {
      type: "list",
      title: txt("copMyOrders", "سفارش‌های من"),
      rows: orders.slice(0, 8).map((o) => ({
        title: `${money(o.total)} · ${dateText(o.submittedAt)}`,
        sub: [...asArray<NonNullable<O["products"]>[number]>(o.products).map((p) => p.item?.product?.name), ...asArray<NonNullable<O["tests"]>[number]>(o.tests).map((t) => t.item?.test?.name)]
          .filter(Boolean)
          .slice(0, 3)
          .join("، "),
        badge: statusTxt("copOrder", o.status),
      })),
      empty: txt("copNoOrders", "سفارشی ندارید"),
      link: `${ctx.panel}/order`,
    };
  },
});

registerCopilotTool({
  name: "my_wallet",
  profiles: ["user"],
  kind: "read",
  description: "My wallet balance and the amount on hold.",
  run: async (ctx) => {
    const w = await invoke<{ balance?: number; pending?: number }>(userController.getWallet, ctx.req);
    return {
      type: "list",
      title: txt("copMyWallet", "کیف پول"),
      rows: [
        { title: money(w?.balance), badge: txt("copBalance", "موجودی") },
        ...(w?.pending ? [{ title: money(w.pending), badge: txt("copOnHold", "در انتظار") }] : []),
      ],
      link: `${ctx.panel}/transaction`,
    };
  },
});

registerCopilotTool({
  name: "my_pro",
  profiles: ["user"],
  kind: "read",
  description: "My Noyan Pro membership: active or not, until when, and today's AI messages left.",
  run: async (ctx) => {
    const [status, usage] = await Promise.all([proStatusOf(ctx.req.user?._id), aiUsageOf(ctx.req.user?._id)]);
    return {
      type: "list",
      title: txt("copMyPro", "عضویت پرو"),
      rows: [
        { title: status.until ? dateText(status.until) : "—", badge: status.active ? txt("copProActive", "پرو فعال است") : txt("copProInactive", "پرو فعال نیست") },
        { title: usage.remaining === null ? "∞" : count(usage.remaining), badge: txt("copAiLeft", "پیام‌های هوش مصنوعی باقی‌مانده‌ی امروز") },
      ],
      link: `${ctx.panel}/pro`,
    };
  },
});

registerCopilotTool({
  name: "health_question",
  // opens the assistant; each message there counts
  aiFeature: "assistant.health",
  aiCounted: true,
  profiles: ["user"],
  kind: "navigate",
  description: "A health question (symptoms, a disease, which doctor to see): open the AI health assistant.",
  run: async () => ({ type: "navigate", path: "/wizard", title: txt("copHealthAssistant", "دستیار سلامت باز شد") }),
});

