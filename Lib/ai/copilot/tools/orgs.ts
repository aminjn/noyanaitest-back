// Profile-specific tools of the centres (clinic / hospital: doctors, the
// agenda across doctors, occupancy), the pharmacy (order and Rx queue),
// the lab / imaging centre (test orders and results) and the insurer
// (plans, network). Each runs the panel's normal read handler in-process.
import { z } from "zod";
import * as centerDoctorsController from "../../../../Controllers/centerDoctorsController";
import * as pharmacyController from "../../../../Controllers/pharmacyController";
import * as paraClinicController from "../../../../Controllers/paraClinicController";
import * as insurerController from "../../../../Controllers/insurerController";
import { invoke, registerCopilotTool } from "../registry";
import { ToolCtx, txt } from "../types";
import { asArray, count, dateText, isYmd, matches, minutesText, money, personName, summarize, ymd, statusTxt } from "./helpers";

type Center = "clinic" | "hospital";
const center = (ctx: ToolCtx) => ctx.profile as Center;
const handlers = {
  doctors: { clinic: centerDoctorsController.getMyDoctors("clinic"), hospital: centerDoctorsController.getMyDoctors("hospital") },
  agenda: { clinic: centerDoctorsController.getMyReservations("clinic"), hospital: centerDoctorsController.getMyReservations("hospital") },
  stats: { clinic: centerDoctorsController.getMyVisitStats("clinic"), hospital: centerDoctorsController.getMyVisitStats("hospital") },
};
type Doc = { _id?: string; firstName?: string; lastName?: string };
const docName = (d?: Doc) => [d?.firstName, d?.lastName].filter(Boolean).join(" ");

// ---------------- clinic / hospital ----------------

registerCopilotTool({
  name: "center_doctors",
  profiles: ["clinic", "hospital"],
  kind: "read",
  description: "The centre's doctors (members) and pending join requests / invitations.",
  args: '{"query": string (optional doctor name)}',
  schema: z.object({ query: z.string().max(100).optional() }),
  acl: "owner",
  run: async (ctx, args) => {
    const d = await invoke<{ members?: { doctor?: Doc & { mainSpeciality?: { name?: string } }; department?: { name?: string } }[]; incoming?: unknown[]; outgoing?: unknown[] }>(
      handlers.doctors[center(ctx)],
      ctx.req,
    );
    const qy = String(args.query || "");
    const members = asArray<NonNullable<typeof d.members>[number]>(d?.members).filter((m) => !qy || matches(docName(m.doctor), qy));
    return {
      type: "list",
      title: txt("copCenterDoctors", "پزشکان مرکز"),
      text: `${count(members.length)} · ${count(asArray(d?.incoming).length)} ↘ · ${count(asArray(d?.outgoing).length)} ↗`,
      rows: members.slice(0, 15).map((m) => ({ title: docName(m.doctor), sub: m.doctor?.mainSpeciality?.name || "" })),
      empty: txt("copNothingFound", "چیزی پیدا نشد"),
      link: `${ctx.panel}/doctor`,
    };
  },
});

registerCopilotTool({
  name: "center_agenda",
  profiles: ["clinic", "hospital"],
  kind: "read",
  description: "The visits of a day across all the centre's doctors (today by default), optionally one doctor.",
  args: '{"date": "YYYY-MM-DD", "doctor": string (name, optional)}',
  schema: z.object({ date: z.string().max(10).optional(), doctor: z.string().max(100).optional() }),
  acl: "readReservations",
  run: async (ctx, args) => {
    const day = isYmd(args.date) ? args.date : ymd();
    const d = await invoke<{ items?: { _id: string; start: number; status: string; sessionType: string; doctor?: Doc; patient?: { givenName?: string; lastName?: string }; office?: { name?: string } }[] }>(
      handlers.agenda[center(ctx)],
      ctx.req,
      { query: { from: day, to: day } },
    );
    const qy = String(args.doctor || "");
    const items = asArray<NonNullable<typeof d.items>[number]>(d?.items).filter((r) => r.status !== "cancelled" && (!qy || matches(docName(r.doctor), qy)));
    const perDoctor = new Map<string, number>();
    for (const r of items) perDoctor.set(docName(r.doctor), (perDoctor.get(docName(r.doctor)) || 0) + 1);
    return {
      type: "list",
      title: txt("copCenterAgenda", "نوبت‌های مرکز در ${1}", [dateText(new Date(`${day}T12:00:00`))]),
      text: [...perDoctor.entries()].map(([n, c]) => `${n}: ${count(c)}`).join(" · ") || undefined,
      rows: items.slice(0, 20).map((r) => ({
        title: `${minutesText(r.start)} · ${personName(r.patient)}`,
        sub: [docName(r.doctor), r.office?.name].filter(Boolean).join(" · "),
        badge: statusTxt("copStatus", r.status),
      })),
      empty: txt("copNoVisits", "نوبتی در این روز نیست"),
      link: `${ctx.panel}/booking`,
    };
  },
});

registerCopilotTool({
  name: "center_occupancy",
  profiles: ["clinic", "hospital"],
  kind: "read",
  description: "Occupancy and visit trend over the last 30 days, with what stands out.",
  run: async (ctx) => {
    const d = await invoke<{ series?: { date: string; visits: number }[]; totals?: { visits: number }; offices?: number }>(handlers.stats[center(ctx)], ctx.req);
    const series = asArray<{ date: string; visits: number }>(d?.series);
    const text = await summarize(
      ctx,
      "Describe this healthcare centre's visit volume over the last 30 days for its manager: the trend, busiest and quietest weekdays, and one practical suggestion.",
      { offices: d?.offices, total: d?.totals?.visits, series },
    );
    return { type: "insight", title: txt("copOccupancy", "اشغال و روند نوبت‌ها"), text, link: `${ctx.panel}/booking` };
  },
});

// ---------------- pharmacy ----------------

type Order = {
  _id: string;
  submittedAt?: string;
  total?: number;
  user?: { username?: string; phone?: string };
  products?: { status?: string; item?: { product?: { name?: string } } }[];
  productPackages?: { status?: string }[];
  tests?: { status?: string; item?: { name?: string }; result?: { uploadedAt?: string } }[];
  shipments?: { shippedAt?: string }[];
};
const orderLine = (o: Order) =>
  [
    ...asArray<NonNullable<Order["products"]>[number]>(o.products).map((p) => p.item?.product?.name),
    ...asArray<NonNullable<Order["tests"]>[number]>(o.tests).map((t) => t.item?.name),
  ]
    .filter(Boolean)
    .slice(0, 3)
    .join("، ");

registerCopilotTool({
  name: "pharmacy_queue",
  profiles: ["pharmacy"],
  kind: "read",
  description: "The paid orders waiting to be prepared or shipped (the pharmacy's order and prescription queue).",
  acl: "readOrders",
  module: "incomingOrders",
  run: async (ctx) => {
    const orders = asArray<Order>(await invoke(pharmacyController.getMyIncomingOrders, ctx.req));
    const waiting = orders.filter((o) => !asArray<{ shippedAt?: string }>(o.shipments).some((s) => s.shippedAt));
    return {
      type: "list",
      title: txt("copOrderQueue", "صف سفارش‌ها"),
      text: `${count(waiting.length)} / ${count(orders.length)}`,
      rows: waiting.slice(0, 12).map((o) => ({
        title: `${o.user?.username || o.user?.phone || ""} · ${money(o.total)}`,
        sub: [orderLine(o), dateText(o.submittedAt)].filter(Boolean).join(" · "),
        link: `${ctx.panel}/order/${o._id}`,
      })),
      empty: txt("copQueueEmpty", "سفارشی در صف نیست"),
      link: `${ctx.panel}/order`,
    };
  },
});

// ---------------- lab / imaging ----------------

registerCopilotTool({
  name: "lab_orders",
  profiles: ["paraClinic"],
  kind: "read",
  description: "Test orders: those waiting for a result, and results already uploaded.",
  args: '{"pending": boolean}',
  schema: z.object({ pending: z.boolean().optional() }),
  acl: "readOrders",
  module: "incomingOrders",
  run: async (ctx, args) => {
    const orders = asArray<Order>(await invoke(paraClinicController.getMyIncomingOrders, ctx.req));
    const waitingResult = (o: Order) => asArray<{ result?: { uploadedAt?: string } }>(o.tests).some((t) => !t.result?.uploadedAt);
    const list = args.pending === false ? orders : orders.filter(waitingResult);
    return {
      type: "list",
      title: txt("copLabOrders", "سفارش‌های آزمایش"),
      text: `${count(orders.filter(waitingResult).length)} / ${count(orders.length)}`,
      rows: list.slice(0, 12).map((o) => ({
        title: `${o.user?.username || o.user?.phone || ""}`,
        sub: [orderLine(o), dateText(o.submittedAt)].filter(Boolean).join(" · "),
        badge: waitingResult(o) ? txt("copAwaitingResult", "در انتظار جواب") : txt("copResultReady", "جواب آماده"),
        link: `${ctx.panel}/order/${o._id}`,
      })),
      empty: txt("copQueueEmpty", "سفارشی در صف نیست"),
      link: `${ctx.panel}/order`,
    };
  },
});

// ---------------- insurer ----------------

registerCopilotTool({
  name: "insurer_plans",
  profiles: ["insurance"],
  kind: "read",
  description: "The insurer's plans (contracts offered to members): name, price, active or not.",
  acl: "managePlans",
  run: async (ctx) => {
    const plans = asArray<{ _id: string; name?: string; price?: number; isActive?: boolean; features?: string[] }>(
      await invoke(insurerController.getMyPlans, ctx.req),
    );
    return {
      type: "list",
      title: txt("copInsurerPlans", "طرح‌های بیمه"),
      rows: plans.map((p) => ({
        title: p.name || "",
        sub: [money(p.price), asArray<string>(p.features).slice(0, 2).join("، ")].filter(Boolean).join(" · "),
        badge: p.isActive ? txt("copActive", "فعال") : txt("copInactive", "غیرفعال"),
      })),
      empty: txt("copNothingFound", "چیزی پیدا نشد"),
      link: `${ctx.panel}/plan`,
    };
  },
});

registerCopilotTool({
  name: "insurer_network",
  profiles: ["insurance"],
  kind: "read",
  description: "The insurer's provider network: how many doctors, clinics, hospitals, labs and pharmacies accept it, optionally in a city.",
  args: '{"city": string (optional)}',
  schema: z.object({ city: z.string().max(60).optional() }),
  acl: "readNetwork",
  run: async (ctx, args) => {
    type P = { name?: string; city?: { name?: string } };
    const d = await invoke<Record<string, P[]>>(insurerController.getMyNetwork, ctx.req);
    const city = String(args.city || "");
    const groups = ["doctors", "clinics", "hospitals", "labs", "pharmacies"] as const;
    const rows = groups.map((g) => {
      const list = asArray<P & Doc>(d?.[g]).filter((x) => !city || matches(String(x.city?.name || ""), city));
      return { title: `${count(list.length)}`, badge: statusTxt("copNet", g), sub: list.slice(0, 3).map((x) => x.name || docName(x)).join("، ") };
    });
    return { type: "list", title: txt("copInsurerNetwork", "شبکه‌ی ارائه‌دهندگان"), rows, link: `${ctx.panel}/network` };
  },
});
