import { startOfTehranDay } from "../Lib/tehranTime";
import { notifyWithSms } from "../Services/notificationSmsService";
import PharmacyAdditionRequest from "../Models/PharmacyAdditionRequest";
import InsuranceAdditionRequest from "../Models/InsuranceAdditionRequest";
import HospitalAdditionRequest from "../Models/HospitalAdditionRequest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Model, Types } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import DoctorProfile from "../Models/DoctorProfile";
import { syncDoctorPublished } from "../Lib/doctorPublish";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Pharmacy from "../Models/Pharmacy";
import BecomePharmacyRequest from "../Models/BecomePharmacyRequest";
import BecomeClinicRequest from "../Models/BecomeClinicRequest";
import BecomeHospitalRequest from "../Models/BecomeHospitalRequest";
import BecomeParaClinicRequest from "../Models/BecomeParaClinicRequest";
import BecomeInsuranceRequest from "../Models/BecomeInsuranceRequest";
import BecomeDoctorRequest from "../Models/BecomeDoctorRequest";
import { resolveGeo } from "../Lib/geoResolve";
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
            // from today (a day key is its day's midnight, Lib/tehranTime.ts)
            date: { $gte: startOfTehranDay(now) },
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
          active: node.active ?? node.isActive,
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

// Approving a "become X" request (2026-09) used to only flip the request's
// status (pharmacy was fixed first; clinic / hospital / paraclinic / insurer
// had the same gap): nothing was created, so the admin had to build the
// centre by hand and link it. One step now, for every centre type: create the
// centre from the request (or reuse the applicant's existing one), link the
// applicant as its user, activate it, mark the request Approved and notify.
// A rejected request can't be approved (reopen it first).
type BecomeKind = "pharmacy" | "clinic" | "hospital" | "paraClinic" | "insurance";

const becomeFlows: Record<
  BecomeKind,
  {
    request: Model<any>;
    org: Model<any>;
    activeField: "active" | "isActive";
    // where the centre keeps its licence (siam) code, if it has a field
    codeField?: string;
    panel: string;
    title: string;
    message: string;
  }
> = {
  pharmacy: {
    request: BecomePharmacyRequest,
    org: Pharmacy,
    activeField: "active",
    panel: "/pharmacypanel",
    title: "درخواست داروخانه‌ی شما تأیید شد",
    message: "پنل داروخانه برای شما فعال شد. پروفایل و محصولات خود را از پنل داروخانه تکمیل کنید.",
  },
  clinic: {
    request: BecomeClinicRequest,
    org: Clinic,
    activeField: "active",
    codeField: "clinicCode",
    panel: "/clinicpanel",
    title: "درخواست کلینیک شما تأیید شد",
    message: "پنل کلینیک برای شما فعال شد. پروفایل، پزشکان و خدمات کلینیک را از پنل تکمیل کنید.",
  },
  hospital: {
    request: BecomeHospitalRequest,
    org: Hospital,
    activeField: "isActive",
    codeField: "code",
    panel: "/hospitalpanel",
    title: "درخواست بیمارستان شما تأیید شد",
    message: "پنل بیمارستان برای شما فعال شد. پروفایل، بخش‌ها و پزشکان را از پنل تکمیل کنید.",
  },
  paraClinic: {
    request: BecomeParaClinicRequest,
    org: ParaClinic,
    activeField: "active",
    panel: "/paraClinicPanel",
    title: "درخواست مرکز پاراکلینیک شما تأیید شد",
    message: "پنل مرکز برای شما فعال شد. پروفایل و آزمایش‌های مرکز را از پنل تکمیل کنید.",
  },
  insurance: {
    request: BecomeInsuranceRequest,
    org: Insurance,
    activeField: "active",
    panel: "/insurancepanel",
    title: "درخواست بیمه‌ی شما تأیید شد",
    message: "پنل بیمه برای شما فعال شد. پروفایل بیمه را از پنل تکمیل کنید.",
  },
};

// the org kind word in the approval SMS's {kind} (translated into the
// pattern's language by notifyWithSms)
const becomeKindLabel: Record<BecomeKind, string> = {
  pharmacy: "داروخانه",
  clinic: "کلینیک",
  hospital: "بیمارستان",
  paraClinic: "مرکز پاراکلینیک",
  insurance: "بیمه",
};

const approveBecome = (kind: BecomeKind): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const flow = becomeFlows[kind];
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const request = await flow.request.findById(nodeId);
    if (!request || !request.user) return next(new NotFoundError());
    if (request.status === "Rejected")
      return next(new BadInputError("درخواست ردشده را نمی‌توان تأیید کرد"));
    let org = await flow.org.findOne({ user: request.user });
    // "approve by linking an existing centre" (the old "assign" popup
    // overwrote the centre's owner and left the request pending): only a
    // centre with no owner, or already the applicant's, can be linked
    const orgId = req.body?.orgId;
    if (orgId !== undefined && orgId !== "") {
      if (!isValidObjectId(orgId)) return next(new BadInputError());
      const existing = await flow.org.findById(orgId);
      if (!existing) return next(new NotFoundError());
      if (existing.user && String(existing.user) !== String(request.user))
        return next(new BadInputError("این مرکز صاحب دیگری دارد و نمی‌توان آن را به این درخواست داد"));
      if (org && String(org._id) !== String(existing._id))
        return next(new BadInputError("متقاضی از قبل مرکز دیگری دارد"));
      existing.user = request.user;
      await existing.save();
      org = existing;
    }
    // approving twice changes nothing: it must not re-activate a centre an
    // admin has deactivated since, nor notify the owner again
    if (request.status === "Approved" && org)
      return res
        .status(200)
        .json({ message: "approveBecome", data: { node: org, kind } });
    // the licence code the applicant gave (and the admin reviewed) is the
    // centre's code: it is not typed a second time (2026-10)
    const code = String(request.siamCode || "").trim();
    if (!org)
      org = await flow.org.create({
        user: request.user,
        name: request.name,
        summary: request.description,
        ...(flow.codeField && code ? { [flow.codeField]: code } : {}),
        [flow.activeField]: true,
      });
    else {
      // the applicant's existing centre: fill a missing licence code and
      // publish it (these were an either/or, so a centre that lacked the
      // code got it but stayed unpublished after "approve and activate")
      if (flow.codeField && code && !org[flow.codeField]) org[flow.codeField] = code;
      if (!org[flow.activeField]) org[flow.activeField] = true;
      if (org.isModified()) await org.save();
    }
    // status only: an old request with a now-invalid field must not leave
    // the centre / profile created but the request still pending
    await request.updateOne({ $set: { status: "Approved", decidedAt: new Date() } });
    await Notification.create({
      user: request.user,
      source: "System",
      title: flow.title,
      message: flow.message,
      link: flow.panel,
    }).catch(() => {});
    notifyWithSms("providerRequestApprovedProvider", request.user, { kind: becomeKindLabel[kind] });
    res.status(200).json({ message: "approveBecome", data: { node: org, kind } });
  });

export const approveBecomePharmacy = approveBecome("pharmacy");
export const approveBecomeClinic = approveBecome("clinic");
export const approveBecomeHospital = approveBecome("hospital");
export const approveBecomeParaClinic = approveBecome("paraClinic");
export const approveBecomeInsurance = approveBecome("insurance");

// Approving a "become a doctor" request (2026-09): used to only flip its
// status. Creates the doctor's profile from the request - name, national id,
// gender, council code, address, the location (static slugs -> Geo ids) and
// the specialities the doctor declared (the first is the main one) - or
// fills the missing parts of the profile the applicant already has.
export const approveBecomeDoctor: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const request = await BecomeDoctorRequest.findById(nodeId);
    if (!request || !request.user) return next(new NotFoundError());
    if (request.status === "Rejected")
      return next(new BadInputError("درخواست ردشده را نمی‌توان تأیید کرد"));
    // approving twice changes nothing (like the centres): it must not
    // re-publish a profile an admin has unpublished since, nor notify again
    if (request.status === "Approved") {
      const existing = await DoctorProfile.findOne({ user: request.user }).select("_id").lean();
      if (existing)
        return res.status(200).json({ message: "approveBecomeDoctor", data: { node: existing } });
    }
    const geo = await resolveGeo(request.province, request.city);
    const specialities = (request.specialities || []).map((el: unknown) =>
      String((el as { _id?: unknown })?._id ?? el),
    );
    const fromRequest = {
      firstName: request.firstName,
      lastName: request.lastName,
      ssid: request.ssid,
      gender: request.gender,
      medicalSystemCode: request.medicalSystemCode,
      medicalSystemTitle: request.medicalSystemTitle,
      address: request.address,
      ...(geo.province ? { province: geo.province } : {}),
      ...(geo.city ? { city: geo.city } : {}),
    };
    let doctor = await DoctorProfile.findOne({ user: request.user }).select("+ssid");
    // approving by linking an existing profile the admin picked (an imported
    // directory profile, or one made earlier): the same checks as setting a
    // panel owner, and the request is approved instead of left pending
    const picked = req.body?.profile;
    if (picked !== undefined && picked !== null && picked !== "") {
      if (typeof picked !== "string" || !isValidObjectId(picked)) return next(new BadInputError());
      const chosen = await DoctorProfile.findById(picked).select("+ssid");
      if (!chosen) return next(new NotFoundError("پروفایل پزشک"));
      if (chosen.user && String(chosen.user) !== String(request.user))
        return next(new AppError("این پروفایل از قبل به حساب دیگری وصل است؛ اول آن را جدا کنید", 400));
      if (doctor && String(doctor._id) !== String(chosen._id))
        return next(new AppError("این حساب از قبل مالک پنل پزشک دیگری است؛ اول آن را جدا کنید", 400));
      chosen.set("user", request.user);
      chosen.set("claimed", true);
      doctor = chosen;
    }
    // claiming: the doctor's unclaimed profile from the old directory (same
    // council code) becomes theirs - one doctor, one page, the old URL and
    // its history kept - instead of a second, duplicate profile
    if (!doctor && fromRequest.medicalSystemCode)
      doctor = await DoctorProfile.findOne({
        claimed: false,
        user: { $exists: false },
        medicalSystemCode: fromRequest.medicalSystemCode,
      }).select("+ssid");
    if (doctor && doctor.get("claimed") === false) {
      doctor.set("user", request.user);
      doctor.set("claimed", true);
    }
    // Approval opens the panel; it does not publish the page (2026-10,
    // doctor profile audit). It used to set active: true at once, so an
    // approved doctor with no photo, office, visit type or hours was listed
    // with a "book" button that led nowhere - and approving a suspended
    // profile failed on the publish guard, leaving the request pending.
    // Now the profile is a draft that goes live by itself once bookable
    // (Lib/doctorPublish.ts), the same rule as the self-service sign-up. A
    // page that is already public (a claimed directory profile) stays so.
    if (!doctor)
      doctor = await DoctorProfile.create({
        ...fromRequest,
        user: request.user,
        specialities,
        mainSpeciality: specialities[0],
        active: false,
        autoPublish: true,
      });
    else {
      // fill only what the existing profile lacks
      for (const [key, value] of Object.entries(fromRequest))
        if (value && !doctor.get(key)) doctor.set(key, value);
      if (!doctor.specialities?.length && specialities.length) {
        doctor.set("specialities", specialities);
        if (!doctor.mainSpeciality) doctor.set("mainSpeciality", specialities[0]);
      }
      if (!doctor.get("active") && doctor.get("status") !== "suspended") doctor.set("autoPublish", true);
      await doctor.save();
    }
    await syncDoctorPublished(doctor._id).catch(() => {});
    // status only: an old request with a now-invalid field must not leave
    // the centre / profile created but the request still pending
    await request.updateOne({ $set: { status: "Approved", decidedAt: new Date() } });
    await Notification.create({
      user: request.user,
      source: "System",
      title: "درخواست همکاری شما به‌عنوان پزشک تأیید شد",
      message: "پنل پزشک برای شما فعال شد. مطب، شیفت‌ها و تنظیمات نوبت را تکمیل کنید تا بیماران بتوانند نوبت بگیرند.",
      link: "/doctorpanel",
    }).catch(() => {});
    notifyWithSms("providerRequestApprovedProvider", request.user, { kind: "پزشک" });
    res.status(200).json({ message: "approveBecomeDoctor", data: { node: doctor } });
  },
);


// Admin decision on a doctor's request to join a clinic / hospital (2026-09).
// The admin page used to create the membership directly and leave the
// request Pending (a second click hit the unique index; nothing could reject
// it). Now: Approved -> the membership exists (idempotent upsert) and the
// request is Approved; Rejected -> the request is Rejected. The doctor is told.
const joinFlows = {
  clinic: {
    request: DoctorJoinClinicRequest as Model<any>,
    member: ClinicDoctor as Model<any>,
    org: Clinic as Model<any>,
    orgField: "clinic",
    label: "کلینیک",
  },
  hospital: {
    request: DoctorJoinHospitalRequest as Model<any>,
    member: HospitalDoctor as Model<any>,
    org: Hospital as Model<any>,
    orgField: "hospital",
    label: "بیمارستان",
  },
} as const;

export const decideDoctorJoin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const kind = req.params.kind as keyof typeof joinFlows;
    const flow = joinFlows[kind];
    const { nodeId } = req.params;
    const decision = req.body?.decision;
    if (!flow || !isValidObjectId(nodeId) || !["Approved", "Rejected"].includes(decision))
      return next(new BadInputError());
    const request = await flow.request.findById(nodeId);
    if (!request?.doctor || !request[flow.orgField]) return next(new NotFoundError());
    // one-way: a decided request isn't flipped (that left the membership in
    // place and notified the doctor again on every click); reject goes
    // through /admin/requests with a reason
    if (request.status !== "Pending")
      return next(new BadInputError("این درخواست قبلاً بررسی شده است"));
    // a centre's invitation is the doctor's to accept, not the admin's
    if (request.submissionParty && request.submissionParty !== "DoctorProfile")
      return next(new BadInputError("این دعوت مرکز است و فقط خود پزشک می‌تواند آن را بپذیرد"));
    if (decision === "Rejected")
      return next(new BadInputError("برای رد درخواست، دلیل آن را از صف درخواست‌ها ثبت کنید"));
    if (decision === "Approved")
      await flow.member.updateOne(
        { doctor: request.doctor, [flow.orgField]: request[flow.orgField] },
        { $setOnInsert: { doctor: request.doctor, [flow.orgField]: request[flow.orgField] } },
        { upsert: true },
      );
    await request.updateOne({
      $set: { status: decision, decidedAt: new Date(), statusLastChangedAt: new Date() },
    });
    const [doctor, org] = await Promise.all([
      DoctorProfile.findById(request.doctor).select("user").lean<{ user?: unknown }>(),
      flow.org.findById(request[flow.orgField]).select("name").lean<{ name?: string }>(),
    ]);
    if (doctor?.user)
      await Notification.create({
        user: doctor.user,
        source: "System",
        title:
          decision === "Approved"
            ? `عضویت شما در ${flow.label} ${org?.name || ""} تأیید شد`
            : `درخواست عضویت شما در ${flow.label} ${org?.name || ""} رد شد`,
        message:
          decision === "Approved"
            ? `از این پس در صفحه‌ی ${flow.label} به‌عنوان پزشک آن نمایش داده می‌شوید.`
            : "می‌توانید دوباره درخواست بدهید یا با پشتیبانی تماس بگیرید.",
        link: `/doctorpanel/${kind}`,
      }).catch(() => {});
    // only "Approved" reaches here (a rejection goes through /admin/requests)
    if (doctor?.user && decision === "Approved")
      notifyWithSms("centreMembershipApprovedDoctor", doctor.user, {
        centre: `${flow.label} ${org?.name || ""}`.trim(),
      });
    res.status(200).json({ message: "decideDoctorJoin", data: { status: decision } });
  },
);

// "A doctor asked us to add a centre they work at" (2026-09). The admin
// popups used to POST the request's legacy province/city slugs straight to
// /auto/<kind>, which fails the ObjectId cast, copied only the name and left
// the request pending. This creates the centre (inactive, so an admin
// reviews it before it goes public) with name, address, phone and the
// location mapped to the Geo collections, links the requesting doctor as a
// member, marks the request Done and tells the doctor. Idempotent: a request
// already Done returns its centre.
const additionFlows = {
  clinic: {
    request: ClinicAdditionRequest as Model<any>,
    org: Clinic as Model<any>,
    member: ClinicDoctor as Model<any>,
    memberField: "clinic",
    activeField: "active",
    name: (r: any) => r.clinicName,
    address: (r: any) => r.clinicAddress,
    label: "کلینیک",
  },
  hospital: {
    request: HospitalAdditionRequest as Model<any>,
    org: Hospital as Model<any>,
    member: HospitalDoctor as Model<any>,
    memberField: "hospital",
    activeField: "isActive",
    name: (r: any) => r.hospitalName,
    address: (r: any) => r.hospitalAddress,
    label: "بیمارستان",
  },
  insurance: {
    request: InsuranceAdditionRequest as Model<any>,
    org: Insurance as Model<any>,
    member: DoctorInsurance as Model<any>,
    memberField: "insurance",
    activeField: "active",
    name: (r: any) => r.name,
    address: () => undefined,
    label: "بیمه",
    // a doctor accepts an insurer, they are not its doctor
    notice: "این بیمه به فهرست بیمه‌های طرف قرارداد شما اضافه شد. صفحه‌ی آن پس از بررسی مدیر عمومی می‌شود.",
  },
  pharmacy: {
    request: PharmacyAdditionRequest as Model<any>,
    org: Pharmacy as Model<any>,
    member: DoctorPharmacy as Model<any>,
    memberField: "pharmacy",
    activeField: "active",
    name: (r: any) => r.name,
    address: (r: any) => r.address,
    label: "داروخانه",
  },
} as const;

// POST /admin/addition/:kind/:nodeId/create
export const createFromAddition: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const flow = additionFlows[req.params.kind as keyof typeof additionFlows];
    const { nodeId } = req.params;
    if (!flow || !isValidObjectId(nodeId)) return next(new NotFoundError());
    const request: any = await flow.request.findById(nodeId).lean();
    if (!request) return next(new NotFoundError());
    if (request.status === "Rejected")
      return next(new BadInputError("درخواست ردشده را نمی‌توان تأیید کرد"));
    const name = String(flow.name(request) || "").trim();
    if (!name) return next(new BadInputError());

    let org: any = request.createdNode
      ? await flow.org.findById(request.createdNode)
      : null;
    // the centre may already be on NoyanAI: the admin links the request to
    // it instead of creating a second one (2026-10)
    const orgId = req.body?.orgId;
    if (!org && orgId) {
      if (!isValidObjectId(orgId)) return next(new BadInputError());
      org = await flow.org.findById(orgId);
      if (!org) return next(new NotFoundError());
    }
    if (!org) {
      const geo = await resolveGeo(request.province, request.city);
      const twin = await flow.org
        .findOne({
          name: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"),
          ...(geo.city ? { city: geo.city } : {}),
        })
        .select("_id")
        .lean();
      if (twin)
        return next(
          new BadInputError("مرکزی با همین نام در همین شهر ثبت شده؛ درخواست را به همان مرکز وصل کنید"),
        );
      // the owner's mobile stays on the request: it is a person's number,
      // not the centre's public phone
      org = await flow.org.create({
        name,
        summary: request.description,
        ...(flow.address(request) && { address: flow.address(request) }),
        ...(geo.province ? { province: geo.province } : {}),
        ...(geo.city ? { city: geo.city } : {}),
        [flow.activeField]: false,
      });
    }
    if (request.submittedBy)
      await flow.member.updateOne(
        { doctor: request.submittedBy, [flow.memberField]: org._id },
        { $setOnInsert: { doctor: request.submittedBy, [flow.memberField]: org._id } },
        { upsert: true },
      );
    await flow.request.updateOne(
      { _id: request._id },
      {
        $set: {
          status: "Done",
          createdNode: org._id,
          ...(request.status !== "Done" ? { decidedAt: new Date() } : {}),
        },
      },
    );
    if (request.status !== "Done" && request.submittedBy) {
      const doctor = await DoctorProfile.findById(request.submittedBy)
        .select("user")
        .lean<{ user?: unknown }>();
      if (doctor?.user)
        await Notification.create({
          user: doctor.user,
          source: "System",
          title: `${flow.label} ${name} به نویان اضافه شد`,
          message:
            ("notice" in flow && flow.notice) ||
            `شما به‌عنوان پزشک این ${flow.label} ثبت شدید. صفحه‌ی آن پس از بررسی مدیر عمومی می‌شود.`,
        }).catch(() => {});
      if (doctor?.user)
        notifyWithSms("additionRequestDoneDoctor", doctor.user, {
          centre: `${flow.label} ${name}`.trim(),
        });
    }
    res.status(200).json({
      message: "createFromAddition",
      data: { node: { _id: org._id, name: org.name }, kind: req.params.kind },
    });
  },
);
