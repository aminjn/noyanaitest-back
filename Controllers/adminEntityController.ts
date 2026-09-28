import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Model, Types } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import { NotFoundError } from "../Lib/AppError";
import DoctorProfile from "../Models/DoctorProfile";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Pharmacy from "../Models/Pharmacy";
import BecomePharmacyRequest from "../Models/BecomePharmacyRequest";
import Notification from "../Models/Notification";
import ParaClinic from "../Models/Paraclinic";
import Insurance from "../Models/Insurance";
import ClinicDoctor from "../Models/ClinicDoctor";
import HospitalDoctor from "../Models/HospitalDoctor";
import DoctorPharmacy from "../Models/DoctorPharmacy";
import DoctorInsurance from "../Models/DoctorInsurance";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import DoctorJoinHospitalRequest from "../Models/DoctorJoinHospitalRequest";
import DoctorProfileLicense from "../Models/DoctorProfileLicense";
import ClinicProfileLicense from "../Models/ClinicProfileLicense";
import HospitalProfileLicense from "../Models/HospitalProfileLicense";
import PharmacyProfileLicense from "../Models/PharmacyProfileLicense";
import ParaClinicProfileLicense from "../Models/ParaClinicProfileLicense";
import InsuranceProfileLicense from "../Models/InsuranceProfileLicense";
import Secretary from "../Models/Secretary";
import Reservation from "../Models/Reservation";
import ProductSeller from "../Models/ProductSeller";
import ParaClinicTest from "../Models/ParaClinicTest";
import AdminAuditLog from "../Models/AdminAuditLog";

// Entity 360 (2026-09 admin UX restructure): everything connected to one
// doctor / centre on a single screen - owner account, memberships, pending
// requests, licence, activity numbers and the admin changes made to it -
// instead of opening a separate admin page for each relation.

const RELATION_LIMIT = 12;
const AUDIT_LIMIT = 8;

type Stat = { key: string; label: string; value: number; href?: string };
type RelationItem = { _id: string; name: string; href: string };
type Relation = { key: string; label: string; total: number; items: RelationItem[] };
type Pending = { key: string; label: string; count: number; href: string };

const personName = (node?: { firstName?: string; lastName?: string } | null) =>
  [node?.firstName, node?.lastName].filter(Boolean).join(" ");

// Linked documents of `model` matching `filter`, shown via `path`.
const relation = async (
  key: string,
  label: string,
  model: Model<any>,
  filter: Record<string, unknown>,
  path: string,
  select: string,
  hrefBase: string,
  name: (node: any) => string,
): Promise<Relation> => {
  const [total, links] = await Promise.all([
    model.countDocuments(filter),
    model.find(filter).limit(RELATION_LIMIT).populate(path, select).lean(),
  ]);
  const items = (links as any[])
    .map((link) => link[path])
    .filter((node) => node && node._id)
    .map((node) => ({
      _id: String(node._id),
      name: name(node) || "بدون نام",
      href: `${hrefBase}/${node._id}`,
    }));
  return { key, label, total, items };
};

const doctorsOf = (key: string, model: Model<any>, field: string, id: Types.ObjectId) =>
  relation(key, "پزشکان", model, { [field]: id }, "doctor", "firstName lastName", "doctorprofile", personName);

type Kind = {
  model: Model<any>;
  license: Model<any>;
  // AdminAuditLog `target` for this entity's /auto routes
  auditTarget: string;
  name: (node: any) => string;
  extra: (id: Types.ObjectId) => Promise<{
    stats?: Stat[];
    relations?: Relation[];
    pending?: Pending[];
  }>;
};

const kinds: Record<string, Kind> = {
  doctorprofile: {
    model: DoctorProfile,
    license: DoctorProfileLicense,
    auditTarget: "doctorprofile",
    name: personName,
    extra: async (id) => {
      const now = new Date();
      const [total, completed, upcoming, revenue, clinics, hospitals, pharmacies, insurances, joinClinic, joinHospital] =
        await Promise.all([
          Reservation.countDocuments({ doctor: id }),
          Reservation.countDocuments({ doctor: id, status: "completed" }),
          Reservation.countDocuments({
            doctor: id,
            status: { $in: ["pending", "active"] },
            date: { $gte: now },
          }),
          Reservation.aggregate([
            { $match: { doctor: id, status: "completed" } },
            { $group: { _id: null, total: { $sum: { $ifNull: ["$total", 0] } } } },
          ]),
          relation("clinics", "کلینیک‌ها", ClinicDoctor, { doctor: id }, "clinic", "name", "clinic", (n) => n.name),
          relation("hospitals", "بیمارستان‌ها", HospitalDoctor, { doctor: id }, "hospital", "name", "hospital", (n) => n.name),
          relation("pharmacies", "داروخانه‌ها", DoctorPharmacy, { doctor: id }, "pharmacy", "name", "pharmacy", (n) => n.name),
          relation("insurances", "بیمه‌ها", DoctorInsurance, { doctor: id }, "insurance", "name", "insurance", (n) => n.name),
          DoctorJoinClinicRequest.countDocuments({ doctor: id, status: "Pending" }),
          DoctorJoinHospitalRequest.countDocuments({ doctor: id, status: "Pending" }),
        ]);
      return {
        stats: [
          { key: "reservations", label: "کل نوبت‌ها", value: total },
          { key: "completed", label: "نوبت‌های انجام‌شده", value: completed },
          { key: "upcoming", label: "نوبت‌های پیش رو", value: upcoming },
          { key: "revenue", label: "درآمد نوبت‌ها (تومان)", value: revenue[0]?.total || 0 },
        ],
        relations: [clinics, hospitals, pharmacies, insurances],
        pending: [
          { key: "joinClinic", label: "درخواست عضویت در کلینیک", count: joinClinic, href: "doctorjoinclinic" },
          { key: "joinHospital", label: "درخواست عضویت در بیمارستان", count: joinHospital, href: "doctorjoinhospital" },
        ],
      };
    },
  },
  clinic: {
    model: Clinic,
    license: ClinicProfileLicense,
    auditTarget: "clinic",
    name: (n) => n.name,
    extra: async (id) => {
      const [doctors, join] = await Promise.all([
        doctorsOf("doctors", ClinicDoctor, "clinic", id),
        DoctorJoinClinicRequest.countDocuments({ clinic: id, status: "Pending" }),
      ]);
      return {
        relations: [doctors],
        pending: [{ key: "join", label: "درخواست عضویت پزشک", count: join, href: "doctorjoinclinic" }],
      };
    },
  },
  hospital: {
    model: Hospital,
    license: HospitalProfileLicense,
    auditTarget: "hospital",
    name: (n) => n.name,
    extra: async (id) => {
      const [doctors, join] = await Promise.all([
        doctorsOf("doctors", HospitalDoctor, "hospital", id),
        DoctorJoinHospitalRequest.countDocuments({ hospital: id, status: "Pending" }),
      ]);
      return {
        relations: [doctors],
        pending: [{ key: "join", label: "درخواست عضویت پزشک", count: join, href: "doctorjoinhospital" }],
      };
    },
  },
  pharmacy: {
    model: Pharmacy,
    license: PharmacyProfileLicense,
    auditTarget: "pharmacy",
    name: (n) => n.name,
    extra: async (id) => {
      const [products, doctors] = await Promise.all([
        ProductSeller.countDocuments({ seller: id }),
        doctorsOf("doctors", DoctorPharmacy, "pharmacy", id),
      ]);
      return {
        stats: [{ key: "products", label: "محصولات", value: products }],
        relations: [doctors],
      };
    },
  },
  paraClinic: {
    model: ParaClinic,
    license: ParaClinicProfileLicense,
    auditTarget: "paraClinic",
    name: (n) => n.name,
    extra: async (id) => {
      const tests = await ParaClinicTest.countDocuments({ paraClinic: id });
      return { stats: [{ key: "tests", label: "آزمایش‌ها", value: tests }] };
    },
  },
  insurance: {
    model: Insurance,
    license: InsuranceProfileLicense,
    auditTarget: "insurance",
    name: (n) => n.name,
    extra: async (id) => ({
      relations: [await doctorsOf("doctors", DoctorInsurance, "insurance", id)],
    }),
  },
};

// GET /admin/entity/:kind/:nodeId
export const getEntityOverview: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const kind = kinds[req.params.kind];
    const { nodeId } = req.params;
    if (!kind || !isValidObjectId(nodeId)) return next(new NotFoundError());
    const node: any = await kind.model
      .findById(nodeId)
      .populate({ path: "user", select: "phone username" })
      .lean();
    if (!node) return next(new NotFoundError());
    const id = new Types.ObjectId(nodeId);

    const [extra, team, license, audit] = await Promise.all([
      kind.extra(id),
      Secretary.countDocuments({ owner: id }),
      kind.license.findOne({ owner: id }).select("displayName startedAt expiresAt").lean(),
      AdminAuditLog.find({ targetId: nodeId })
        .sort({ createdAt: -1 })
        .limit(AUDIT_LIMIT)
        .populate({ path: "actor", select: "phone username" })
        .select("action actor fields createdAt")
        .lean(),
    ]);

    const lic: any = license;
    res.status(200).json({
      message: "getEntityOverview",
      data: {
        data: {
          _id: String(node._id),
          name: kind.name(node) || "",
          active: node.active,
          slug: node.slug,
          owner: node.user?._id
            ? { _id: String(node.user._id), phone: node.user.phone, username: node.user.username }
            : null,
          rating:
            typeof node.averageScore === "number"
              ? { average: node.averageScore, count: node.commentCount || 0 }
              : null,
          stats: [
            ...(extra.stats || []),
            { key: "team", label: "اعضای تیم", value: team },
          ],
          relations: extra.relations || [],
          pending: (extra.pending || []).filter((item) => item.count > 0),
          license: lic
            ? {
                displayName: lic.displayName || "",
                startedAt: lic.startedAt || null,
                expiresAt: lic.expiresAt || null,
                isExpired: !!lic.expiresAt && new Date(lic.expiresAt) < new Date(),
              }
            : null,
          audit: (audit as any[]).map((row) => ({
            _id: String(row._id),
            action: row.action,
            fields: row.fields || [],
            createdAt: row.createdAt,
            actor: row.actor
              ? row.actor.username || row.actor.phone || ""
              : "",
          })),
        },
      },
    });
  },
);

// Approving a "become a pharmacy" request (2026-09) used to only flip the
// request's status: no Pharmacy was created, so the admin had to create one
// by hand and link it to the applicant. This does it in one step - creates
// the pharmacy from the request (name), links the applicant as its user,
// activates it, marks the request Approved and notifies the applicant. If the
// applicant already has a pharmacy, that one is linked instead of a duplicate.
export const approveBecomePharmacy: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const request = await BecomePharmacyRequest.findById(nodeId);
    if (!request || !request.user) return next(new NotFoundError());
    let pharmacy = await Pharmacy.findOne({ user: request.user });
    if (!pharmacy)
      pharmacy = await Pharmacy.create({
        user: request.user,
        name: request.name,
        summary: request.description,
        active: true,
      });
    else if (!pharmacy.active) {
      pharmacy.active = true;
      await pharmacy.save();
    }
    request.status = "Approved";
    await request.save();
    await Notification.create({
      user: request.user,
      source: "System",
      title: "درخواست داروخانه‌ی شما تأیید شد",
      message:
        "پنل داروخانه برای شما فعال شد. پروفایل و محصولات خود را از پنل داروخانه تکمیل کنید.",
      link: "/pharmacypanel",
    }).catch(() => {});
    res
      .status(200)
      .json({ message: "approveBecomePharmacy", data: { pharmacy } });
  },
);
