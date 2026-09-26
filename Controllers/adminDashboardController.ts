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
  { key: "insuranceAddition", title: "اضافه شدن بیمه", href: "insuranceaddition", model: InsuranceAdditionRequest, filter: { status: { $in: ["Pending", "Proccessing"] } } },
  { key: "doctorJoinClinic", title: "عضویت پزشک در کلینیک", href: "doctorjoinclinic", model: DoctorJoinClinicRequest, filter: { status: "Pending" } },
  { key: "doctorJoinHospital", title: "عضویت پزشک در بیمارستان", href: "doctorjoinhospital", model: DoctorJoinHospitalRequest, filter: { status: "Pending" } },
  { key: "tickets", title: "تیکت‌های باز", href: "ticket", model: Ticket, filter: { status: { $in: ["Open", "InProgress"] } } },
  { key: "contactRequests", title: "درخواست‌های تماس", href: "contactRequest", model: ContactRequest, filter: { status: "pending" } },
  { key: "paymentsNeedReview", title: "پرداخت‌های نیازمند بررسی", model: GatewayPayment, filter: { status: "needsReview" } },
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
