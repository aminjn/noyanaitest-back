import PharmacyAdditionRequest from "../Models/PharmacyAdditionRequest";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { Model, Types } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import User from "../Models/User";
import DoctorProfile from "../Models/DoctorProfile";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Pharmacy from "../Models/Pharmacy";
import ParaClinic from "../Models/Paraclinic";
import Insurance from "../Models/Insurance";
import BecomeDoctorRequest from "../Models/BecomeDoctorRequest";
import BecomeClinicRequest from "../Models/BecomeClinicRequest";
import BecomePharmacyRequest from "../Models/BecomePharmacyRequest";
import BecomeInsuranceRequest from "../Models/BecomeInsuranceRequest";
import BecomeParaClinicRequest from "../Models/BecomeParaClinicRequest";
import BecomeHospitalRequest from "../Models/BecomeHospitalRequest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import HospitalAdditionRequest from "../Models/HospitalAdditionRequest";
import InsuranceAdditionRequest from "../Models/InsuranceAdditionRequest";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import DoctorJoinHospitalRequest from "../Models/DoctorJoinHospitalRequest";
import Ticket from "../Models/Ticket";
import Comment from "../Models/Comment";
import DoctorFeedBack from "../Models/DoctorFeedback";
import ContactRequest from "../Models/ContactRequest";
import GatewayPayment from "../Models/GatewayPayment";
import Order from "../Models/Order";
import Reservation from "../Models/Reservation";

const TIMEZONE = "Asia/Tehran";
const SERIES_DAYS = 30;
const RECENT_USERS = 8;

// Work queue shown on the admin dashboard. `href` is the admin panel page
// (under /<adminKey>/) where the item is handled.
const pendingSources: {
  key: string;
  title: string;
  href?: string;
  model: Model<any>;
  filter: Record<string, unknown>;
}[] = [
  { key: "becomeDoctor", title: "درخواست پزشک شدن", href: "becomedoctor", model: BecomeDoctorRequest, filter: { status: "Pending" } },
  { key: "becomeClinic", title: "درخواست کلینیک شدن", href: "becomeclinic", model: BecomeClinicRequest, filter: { status: "Pending" } },
  { key: "becomePharmacy", title: "درخواست داروخانه شدن", href: "becomepharmacy", model: BecomePharmacyRequest, filter: { status: "Pending" } },
  { key: "becomeInsurance", title: "درخواست بیمه شدن", href: "becomeinsurance", model: BecomeInsuranceRequest, filter: { status: "Pending" } },
  { key: "becomeParaClinic", title: "درخواست پاراکلینیک شدن", href: "becomeParaClinic", model: BecomeParaClinicRequest, filter: { status: "Pending" } },
  { key: "becomeHospital", title: "درخواست بیمارستان شدن", href: "becomehospital", model: BecomeHospitalRequest, filter: { status: "Pending" } },
  { key: "clinicAddition", title: "اضافه شدن کلینیک", href: "clinicaddition", model: ClinicAdditionRequest, filter: { status: { $in: ["Pending", "Proccessing"] } } },
  { key: "hospitalAddition", title: "اضافه شدن بیمارستان", href: "hospitaladdition", model: HospitalAdditionRequest, filter: { status: { $in: ["Pending", "Proccessing"] } } },
  { key: "pharmacyAddition", title: "اضافه شدن داروخانه", href: "pharmacyaddition", model: PharmacyAdditionRequest, filter: { status: { $in: ["Pending", "Proccessing"] } } },
  { key: "insuranceAddition", title: "اضافه شدن بیمه", href: "insuranceaddition", model: InsuranceAdditionRequest, filter: { status: { $in: ["Pending", "Proccessing"] } } },
  { key: "doctorJoinClinic", title: "عضویت پزشک در کلینیک", href: "doctorjoinclinic", model: DoctorJoinClinicRequest, filter: { status: "Pending" } },
  { key: "doctorJoinHospital", title: "عضویت پزشک در بیمارستان", href: "doctorjoinhospital", model: DoctorJoinHospitalRequest, filter: { status: "Pending" } },
  { key: "tickets", title: "تیکت‌های باز", href: "ticket", model: Ticket, filter: { status: { $in: ["Open", "InProgress"] } } },
  { key: "contactRequests", title: "درخواست‌های تماس", href: "contactRequest", model: ContactRequest, filter: { status: "pending" } },
  { key: "doctorFeedbacks", title: "نظرات بیماران در انتظار تایید", href: "doctorFeedback", model: DoctorFeedBack, filter: { status: "Pending" } },
  { key: "paymentsNeedReview", title: "پرداخت‌های نیازمند بررسی", href: "finance/payments?status=needsReview", model: GatewayPayment, filter: { status: "needsReview" } },
];

// "YYYY-MM-DD" in Tehran time for each of the last `days` days, oldest first.
const lastDays = (days: number) => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const result: string[] = [];
  for (let i = days - 1; i >= 0; i--)
    result.push(fmt.format(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
  return result;
};

const dailyCounts = async (
  model: Model<any>,
  dateExpr: unknown,
  sinceMatch: Record<string, unknown>,
  days: string[],
) => {
  const rows: { _id: string; count: number }[] = await model.aggregate([
    { $match: sinceMatch },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: dateExpr, timezone: TIMEZONE },
        },
        count: { $sum: 1 },
      },
    },
  ]);
  const byDay = new Map(rows.map((row) => [row._id, row.count]));
  return days.map((date) => ({ date, count: byDay.get(date) || 0 }));
};

export const getDashboard: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const days = lastDays(SERIES_DAYS);
    const since = new Date(Date.now() - SERIES_DAYS * 24 * 60 * 60 * 1000);
    // User has no createdAt - its ObjectId carries the creation time.
    const sinceId = Types.ObjectId.createFromTime(
      Math.floor(since.getTime() / 1000),
    );

    const [
      users,
      newUsers,
      doctors,
      clinics,
      hospitals,
      pharmacies,
      paraClinics,
      insurances,
      pending,
      paidOrders,
      reservationsByStatus,
      signups,
      reservations,
      recentUsers,
    ] = await Promise.all([
      User.estimatedDocumentCount(),
      User.countDocuments({ _id: { $gte: sinceId } }),
      DoctorProfile.estimatedDocumentCount(),
      Clinic.estimatedDocumentCount(),
      Hospital.estimatedDocumentCount(),
      Pharmacy.estimatedDocumentCount(),
      ParaClinic.estimatedDocumentCount(),
      Insurance.estimatedDocumentCount(),
      Promise.all(
        pendingSources.map(async ({ key, title, href, model, filter }) => ({
          key,
          title,
          href,
          count: await model.countDocuments(filter),
        })),
      ),
      Order.aggregate([
        { $match: { status: "paid", submittedAt: { $gte: since } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$total" } } },
      ]),
      Reservation.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            total: { $sum: { $ifNull: ["$total", 0] } },
          },
        },
      ]),
      dailyCounts(User, { $toDate: "$_id" }, { _id: { $gte: sinceId } }, days),
      dailyCounts(Reservation, "$createdAt", { createdAt: { $gte: since } }, days),
      User.find().sort({ _id: -1 }).limit(RECENT_USERS).select("phone username role"),
    ]);

    const reservationStatus = Object.fromEntries(
      reservationsByStatus.map((row: any) => [row._id, row.count]),
    );
    const reservationRevenue = reservationsByStatus
      .filter((row: any) => row._id === "completed")
      .reduce((sum: number, row: any) => sum + row.total, 0);

    res.status(200).json({
      message: "getDashboard",
      data: {
        data: {
          generatedAt: new Date(),
          periodDays: SERIES_DAYS,
          totals: {
            users,
            newUsers,
            doctors,
            clinics,
            hospitals,
            pharmacies,
            paraClinics,
            insurances,
          },
          pending: pending.filter((item) => item.count > 0),
          orders: {
            paidCount: paidOrders[0]?.count || 0,
            paidTotal: paidOrders[0]?.total || 0,
          },
          reservations: {
            total: Object.values(reservationStatus).reduce(
              (sum: number, n) => sum + (n as number),
              0,
            ),
            byStatus: reservationStatus,
            completedTotal: reservationRevenue,
          },
          series: { signups, reservations },
          recentUsers: recentUsers.map((user) => ({
            _id: user._id,
            phone: user.phone,
            username: user.username,
            role: user.role,
            createdAt: user._id.getTimestamp(),
          })),
        },
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Unified request inbox (2026-09 admin UX restructure). One queue for every
// kind of pending work that used to live on 14 separate admin pages, so an
// admin no longer opens each page to find out whether there's anything to
// do. Items link to the page where they're handled (the detail page when
// there is one).

const INBOX_LIMIT = 50;

type InboxItem = {
  _id: string;
  kind: string;
  title: string;
  subtitle?: string;
  date?: Date;
  href: string;
};

const personName = (node?: { firstName?: string; lastName?: string }) =>
  [node?.firstName, node?.lastName].filter(Boolean).join(" ");

const inboxSources: {
  key: string;
  title: string;
  model: Model<any>;
  filter: Record<string, unknown>;
  dateField: string;
  populate?: { path: string; select: string }[];
  map: (node: any) => Omit<InboxItem, "_id" | "kind" | "date">;
}[] = [
  ...(
    [
      ["becomeDoctor", "درخواست پزشک شدن", BecomeDoctorRequest, "becomedoctor"],
      ["becomeClinic", "درخواست کلینیک شدن", BecomeClinicRequest, "becomeclinic"],
      ["becomeHospital", "درخواست بیمارستان شدن", BecomeHospitalRequest, "becomehospital"],
      ["becomePharmacy", "درخواست داروخانه شدن", BecomePharmacyRequest, "becomepharmacy"],
      ["becomeParaClinic", "درخواست پاراکلینیک شدن", BecomeParaClinicRequest, "becomeParaClinic"],
      ["becomeInsurance", "درخواست بیمه شدن", BecomeInsuranceRequest, "becomeinsurance"],
    ] as [string, string, Model<any>, string][]
  ).map(([key, title, model, href]) => ({
    key,
    title,
    model,
    filter: { status: "Pending" },
    dateField: "createdAt",
    populate: [{ path: "user", select: "phone" }],
    map: (node: any) => ({
      title: node.name || personName(node) || "—",
      subtitle: node.user?.phone,
      href: `${href}/${node._id}`,
    }),
  })),
  {
    key: "clinicAddition",
    title: "اضافه شدن کلینیک",
    model: ClinicAdditionRequest,
    filter: { status: { $in: ["Pending", "Proccessing"] } },
    dateField: "submittedAt",
    populate: [{ path: "submittedBy", select: "firstName lastName" }],
    map: (node) => ({
      title: node.clinicName || "—",
      subtitle: personName(node.submittedBy),
      href: "clinicaddition",
    }),
  },
  {
    key: "hospitalAddition",
    title: "اضافه شدن بیمارستان",
    model: HospitalAdditionRequest,
    filter: { status: { $in: ["Pending", "Proccessing"] } },
    dateField: "submittedAt",
    populate: [{ path: "submittedBy", select: "firstName lastName" }],
    map: (node) => ({
      title: node.hospitalName || "—",
      subtitle: personName(node.submittedBy),
      href: "hospitaladdition",
    }),
  },
  {
    key: "insuranceAddition",
    title: "اضافه شدن بیمه",
    model: InsuranceAdditionRequest,
    filter: { status: { $in: ["Pending", "Proccessing"] } },
    dateField: "submittedAt",
    populate: [{ path: "submittedBy", select: "firstName lastName" }],
    map: (node) => ({
      title: node.name || "—",
      subtitle: personName(node.submittedBy),
      href: "insuranceaddition",
    }),
  },
  {
    key: "pharmacyAddition",
    title: "اضافه شدن داروخانه",
    model: PharmacyAdditionRequest,
    filter: { status: { $in: ["Pending", "Proccessing"] } },
    dateField: "submittedAt",
    populate: [{ path: "submittedBy", select: "firstName lastName" }],
    map: (node) => ({
      title: node.name || "—",
      subtitle: personName(node.submittedBy),
      href: "pharmacyaddition",
    }),
  },
  {
    // money taken from a card that reached neither the wallet nor the card
    key: "paymentsNeedReview",
    title: "پرداخت‌های نیازمند بررسی",
    model: GatewayPayment,
    filter: { status: "needsReview" },
    dateField: "createdAt",
    populate: [{ path: "user", select: "phone" }],
    map: (node) => ({
      title: `${Number(node.amount || 0).toLocaleString("fa-IR")} تومان`,
      subtitle: node.user?.phone,
      href: "finance/payments?status=needsReview",
    }),
  },
  {
    key: "doctorJoinClinic",
    title: "عضویت پزشک در کلینیک",
    model: DoctorJoinClinicRequest,
    filter: { status: "Pending" },
    dateField: "submittedAt",
    populate: [
      { path: "doctor", select: "firstName lastName" },
      { path: "clinic", select: "name" },
    ],
    map: (node) => ({
      title: personName(node.doctor) || "—",
      subtitle: node.clinic?.name,
      href: "doctorjoinclinic",
    }),
  },
  {
    key: "doctorJoinHospital",
    title: "عضویت پزشک در بیمارستان",
    model: DoctorJoinHospitalRequest,
    filter: { status: "Pending" },
    dateField: "submittedAt",
    populate: [
      { path: "doctor", select: "firstName lastName" },
      { path: "hospital", select: "name" },
    ],
    map: (node) => ({
      title: personName(node.doctor) || "—",
      subtitle: node.hospital?.name,
      href: "doctorjoinhospital",
    }),
  },
  {
    key: "tickets",
    title: "تیکت‌های باز",
    model: Ticket,
    filter: { status: { $in: ["Open", "InProgress"] } },
    dateField: "submittedAt",
    populate: [{ path: "submittedBy", select: "phone" }],
    map: (node) => ({
      title: node.title || "—",
      subtitle: node.submittedBy?.phone,
      href: `ticket/${node._id}`,
    }),
  },
  {
    key: "contactRequests",
    title: "درخواست‌های تماس",
    model: ContactRequest,
    filter: { status: "pending" },
    dateField: "submittedAt",
    map: (node) => ({
      title: node.name || "—",
      subtitle: node.phone,
      href: `contactRequest/${node._id}`,
    }),
  },
  {
    key: "comments",
    title: "نظرات در انتظار تایید",
    model: Comment,
    filter: { status: "Pending" },
    dateField: "createdAt",
    populate: [{ path: "author", select: "phone" }],
    map: (node) => ({
      title:
        typeof node.content === "string"
          ? node.content.slice(0, 80)
          : node.author?.phone || "—",
      subtitle: node.author?.phone,
      href: `comment/${node._id}`,
    }),
  },
  {
    key: "doctorFeedbacks",
    title: "نظرات بیماران در انتظار تایید",
    model: DoctorFeedBack,
    filter: { status: "Pending" },
    dateField: "submittedAt",
    populate: [{ path: "doctor", select: "firstName lastName" }],
    map: (node) => ({
      title:
        (typeof node.publicMessage === "string" && node.publicMessage.slice(0, 80)) ||
        `${node.overalScore ?? "—"} ستاره`,
      subtitle: `${node.doctor?.firstName || ""} ${node.doctor?.lastName || ""}`.trim(),
      href: "doctorFeedback",
    }),
  },
];

export const getInbox: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // ?countOnly=1: just the per-kind counts (the sidebar badge).
    const countOnly = !!req.query.countOnly;
    const groups = await Promise.all(
      inboxSources.map(async (source) => {
        if (countOnly)
          return {
            key: source.key,
            title: source.title,
            count: await source.model.countDocuments(source.filter),
            items: [] as InboxItem[],
          };
        let query = source.model
          .find(source.filter)
          .sort({ [source.dateField]: -1 })
          .limit(INBOX_LIMIT);
        for (const pop of source.populate || [])
          query = query.populate(pop.path, pop.select);
        const [count, nodes] = await Promise.all([
          source.model.countDocuments(source.filter),
          query.lean(),
        ]);
        const items: InboxItem[] = (nodes as any[]).map((node) => ({
          ...source.map(node),
          _id: String(node._id),
          kind: source.key,
          date: node[source.dateField],
        }));
        return { key: source.key, title: source.title, count, items };
      }),
    );

    res.status(200).json({
      message: "getInbox",
      data: {
        data: {
          kinds: groups.map(({ key, title, count }) => ({ key, title, count })),
          items: groups
            .flatMap((group) => group.items)
            .sort(
              (a, b) =>
                new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime(),
            ),
        },
      },
    });
  },
);
