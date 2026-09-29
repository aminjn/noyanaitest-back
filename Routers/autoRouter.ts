import Reservation from "../Models/Reservation";
import PharmacyAdditionRequest from "../Models/PharmacyAdditionRequest";
import { registerAuditSingletons } from "../Services/adminAudit";
import express, { RequestHandler } from "express";
import { Model, PopulateOptions } from "mongoose";
import * as z from "zod";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";
import * as contentTranslationController from "../Controllers/contentTranslationController";
import Blog from "../Models/Blog";
import BlogCategory from "../Models/BlogCategory";
import InlineAdvertisement from "../Models/InlineAdvertisement";
import BlogMedia from "../Models/BlogMedia";
import TextContent from "../Models/TextContent";
import Speciality from "../Models/Speciality";
import BecomeDoctorRequest from "../Models/BecomeDoctorRequest";
import User from "../Models/User";
import DoctorProfile from "../Models/DoctorProfile";
import Doctor from "../Models/Doctor";
import GalleryItem from "../Models/GalleryItem";
import AccessLevel, { AccessLevelModel } from "../Models/AccessLevel";
import UserAccessLevel from "../Models/UserAccessLevel";
import Clinic from "../Models/Clinic";
import ClinicDepartment from "../Models/ClinicDepatment";
import ClinicDoctor from "../Models/ClinicDoctor";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import Insurance from "../Models/Insurance";
import BaseInsuranceLicense from "../Models/BaseInsuranceLicense";
import InsuranceProfileLicense from "../Models/InsuranceProfileLicense";
import InsuranceAdditionRequest from "../Models/InsuranceAdditionRequest";
import Pharmacy from "../Models/Pharmacy";
import BecomeClinicRequest from "../Models/BecomeClinicRequest";
import BecomeInsuranceRequest from "../Models/BecomeInsuranceRequest";
import BecomePharmacyRequest from "../Models/BecomePharmacyRequest";
import BasePharmacyLicense from "../Models/BasePharmacyLicense";
import PharmacyProfileLicense from "../Models/PharmacyProfileLicense";
import BaseClinicLicense from "../Models/BaseClinicLicense";
import ClinicProfileLicense from "../Models/ClinicProfileLicense";
import BaseParaClinicLicense from "../Models/BaseParaClinicLicense";
import ParaClinicProfileLicense from "../Models/ParaClinicProfileLicense";
import CallRoom from "../Models/CallRoom";
import Redirection from "../Models/Redirection";
import ShortLink from "../Models/ShortLink";
import Disease from "../Models/Disease";
import Drug from "../Models/Drug";
import Symptom from "../Models/Symptom";
import Part from "../Models/Part";
import DoctorFaq from "../Models/DoctorFaq";
import TaminServiceType from "../Models/TaminServiceType";
import TaminPrescriptionType from "../Models/TaminPrescriptionType";
import TaminService from "../Models/TaminService";
import TaminParTaref from "../Models/TaminParTaref";
import TaminDrugUsage from "../Models/TaminDrugUsage";
import TaminDrugInstruction from "../Models/TaminDrugInstruction";
import TaminDrugAmount from "../Models/TaminDrugAmount";
import TaminPhPlan from "../Models/TaminPhPlan";
import TaminPhIllness from "../Models/TaminPhIllness";
import TaminIcid from "../Models/TaminIdid";
import TaminComplaint from "../Models/TaminComplaint";
import TaminSpec from "../Models/TaminSpec";
import AiExample from "../Models/AiExample";
import HomeIntroduction from "../Models/HomeIntroduction";
import Advertisement from "../Models/Advertisement";
import Service from "../Models/Service";
import Faq from "../Models/Faq";
import OllamaModel from "../Models/Bot/OllamaModel";
import GlobalOllamaSettings from "../Models/Bot/GlobalOllamaSettings";
import BotInstruction from "../Models/Bot/BotInstruction";
import ServiceCategory from "../Models/ServiceCategory";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import BecomeParaClinicRequest from "../Models/BecomeParaClinicRequest";
import ParaClinic from "../Models/Paraclinic";
import ProductCategory from "../Models/ProductCategory";
import Product from "../Models/Product";
import ProductImage from "../Models/ProductImage";
import ProductSeller from "../Models/ProductSeller";
import ProductSpec from "../Models/ProductSpec";
import ClinicCategory from "../Models/ClinicCategory";
import DiseaseCategory from "../Models/DiseaseCategory";
import DiseaseTag from "../Models/DiseaseTag";
import DrugTag from "../Models/Drugtag";
import SpecialityCategory from "../Models/SpecialityCategory";
import ClinicTag from "../Models/ClinicTag";
import Hospital from "../Models/Hospital";
import HospitalCategory from "../Models/HospitalCategory";
import HospitalTag from "../Models/HospitalTag";
import HospitalDepartment from "../Models/HospitalDepartment";
import HospitalDoctor from "../Models/HospitalDoctor";
import DoctorJoinHospitalRequest from "../Models/DoctorJoinHospitalRequest";
import HospitalAdditionRequest from "../Models/HospitalAdditionRequest";
import BecomeHospitalRequest from "../Models/BecomeHospitalRequest";
import BaseHospitalLicense from "../Models/BaseHospitalLicense";
import HospitalProfileLicense from "../Models/HospitalProfileLicense";
import Test from "../Models/Test";
import TestCategory from "../Models/TestCategory";
import ParaClinicTest from "../Models/ParaClinicTest";
import ParaClinicTag from "../Models/ParaClinicTag";
import ParaClinicCategory from "../Models/ParaClinicCategory";
import ServicePackage from "../Models/ServicePackage";
import ProductPackage from "../Models/ProductPackage";
import SymptomCategory from "../Models/SymptomCategory";
import Comment from "../Models/Comment";
import DoctorFeedBack, {
  doctorFeedbackStatuses,
} from "../Models/DoctorFeedback";
import HospitalClinic from "../Models/HospitalClinic";
import InsuranceCategory from "../Models/InsuranceCategory";
import InsuranceTag from "../Models/InsuranceTag";
import InsurancePlan from "../Models/InsurancePlan";
import FaqCategory from "../Models/FaqCategory";
import ContactRequest from "../Models/ContactRequest";
import PrivacySection from "../Models/PrivacySection";
import AboutPartner from "../Models/AboutPartner";
import AboutTeam from "../Models/AboutTeam";
import AboutWhy from "../Models/AboutWhy";
import Testify from "../Models/Testify";
import PageMeta from "../Models/PageMeta";
import Ticket from "../Models/Ticket";
import TicketMessage from "../Models/TicketMessage";
import Notification from "../Models/Notification";
import PushSubscription from "../Models/PushSubscription";
import AppConfig from "../Models/AppConfig";
import BlogTag from "../Models/BlogTag";
import BlogRRS from "../Models/BlogRRS";
import PharmacyFinanceSettings from "../Models/PharmacyFinanceSettings";
import DoctorFinanceSettings from "../Models/DoctorFinanceSettings";
import ParaClinicFinanceSettings from "../Models/ParaClinicFinanceSettings";
import GlobalFinanceSettings from "../Models/GlobalFinanceSettings";
import PharmacyTaxSettings from "../Models/PharmacyTaxSettings";
import DoctorTaxSettings from "../Models/DoctorTaxSettings";
import ClinicTaxSettings from "../Models/ClinicTaxSettings";
import ParaClinicTaxSettings from "../Models/ParaClinicTaxSettings";
import GlobalTaxSettings from "../Models/GlobalTaxSettings";
import BaseDoctorLicense from "../Models/BaseDoctorLicense";
import DoctorProfileLicense from "../Models/DoctorProfileLicense";
import UserAlert from "../Models/UserAlert";
import LicenseDuration from "../Models/LicenseDuration";
import SmsPatterns from "../Models/SmsPatterns";
import StaticImages from "../Models/StaticImages";
import BookingDescription from "../Models/BookingDescription";

const router = express.Router();

// A speciality in use (doctors, diseases, the legacy directory) cannot be
// deleted - it would leave cards and filters pointing at nothing; deactivate
// it instead.
const specialityRemoveGuard = async (id: string) => {
  const used =
    (await DoctorProfile.exists({
      $or: [{ mainSpeciality: id }, { specialities: id }],
    })) ||
    (await Doctor.exists({ $or: [{ speciality: id }, { specialities: id }] })) ||
    (await Disease.exists({ specialities: id }));
  return used ? "این تخصص به پزشک یا بیماری وصل است؛ به‌جای حذف، غیرفعالش کنید" : null;
};

// A doctor with bookings keeps their profile (medical and money history
// point at it); one without is deleted along with their centre memberships.
const doctorProfileRemoveGuard = async (id: string) => {
  if (await Reservation.exists({ doctor: id }))
    return "این پزشک نوبت ثبت‌شده دارد؛ به‌جای حذف، پروفایل را غیرفعال کنید";
  await Promise.all([
    ClinicDoctor.deleteMany({ doctor: id }),
    HospitalDoctor.deleteMany({ doctor: id }),
  ]);
  return null;
};

const becomeStatusEditSchema = z.strictObject({
  status: z.enum(["Pending", "Rejected"]),
});

const map: {
  name: string;
  model: Model<any>;
  one?: boolean;
  all?: boolean;
  create?: boolean;
  remove?: boolean;
  // refuses the delete (returns the reason) while other records need it
  removeGuard?: (nodeId: string) => Promise<string | null>;
  edit?: boolean;
  singleton?: boolean;
  allPopulation?: PopulateOptions | PopulateOptions[];
  allSelection?: Record<string, number | boolean | string | object>;
  onePopulation?: PopulateOptions | PopulateOptions[];
  editBodyMutator?: RequestHandler;
  accessLevel?: AccessLevelModel;
  // Optional Zod validation (AUDIT F-09, see autoController.validateBody /
  // validateQuery). Left unset for now on every entry below on purpose -
  // these are meant to be filled in incrementally, model by model, in
  // later sessions. `editSchema` validates req.body on both create and
  // edit/editSingleton; `querySchema` validates req.query on get/getAll.
  // A segment with no schema set behaves exactly as before this change -
  // validation is skipped, not defaulted to some implicit shape.
  editSchema?: z.ZodTypeAny;
  querySchema?: z.ZodTypeAny;
}[] = [
  {
    name: "blog",
    model: Blog,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allSelection: { content: false },
    allPopulation: [
      { path: "related", select: ["title", "_id"] },
      { path: "category" },
    ],
    editBodyMutator: autoController.mutateCompoundFields(["related", "tags"]),
    accessLevel: "Blog",
  },
  {
    name: "blogcategory",
    model: BlogCategory,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    accessLevel: "BlogCategory",
  },
  {
    name: "inlinead",
    model: InlineAdvertisement,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "InlineAdvertisement",
  },
  {
    name: "blogmedia",
    model: BlogMedia,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    accessLevel: "BlogMedia",
  },
  {
    name: "textcontent",
    model: TextContent,
    singleton: true,
    edit: true,
    accessLevel: "TextContent",
  },
  {
    name: "speciality",
    model: Speciality,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    removeGuard: specialityRemoveGuard,
    accessLevel: "Sepciality",
  },
  {
    name: "becomedoctor",
    model: BecomeDoctorRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }, { path: "specialities" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeDoctorRequest",
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: becomeStatusEditSchema,
  },
  {
    name: "becomeclinic",
    model: BecomeClinicRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeClinicRequest",
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: becomeStatusEditSchema,
  },
  {
    name: "becomehospital",
    model: BecomeHospitalRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeHospitalRequest",
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: becomeStatusEditSchema,
  },
  {
    name: "becomeinsurance",
    model: BecomeInsuranceRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeInsuranceRequest",
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: becomeStatusEditSchema,
  },
  {
    name: "becomepharmacy",
    model: BecomePharmacyRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomePharmacyRequest",
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: becomeStatusEditSchema,
  },
  {
    name: "user",
    all: true,
    one: true,
    edit: true,
    model: User,
    accessLevel: "User",
    editBodyMutator: autoController.adminOnlyFields({
      fields: ["role", "phone"],
      model: User,
    }),
  },
  {
    name: "doctorprofile",
    model: DoctorProfile,
    all: true,
    one: true,
    edit: true,
    remove: true,
    removeGuard: doctorProfileRemoveGuard,
    create: true,
    allPopulation: [
      { path: "phoneConsultSettings" },
      { path: "user" },
      { path: "mainSpeciality" },
    ],
    onePopulation: [{ path: "phoneConsultSettings" }],
    editBodyMutator: autoController.mutateCompoundFields([
      "services",
      "achivements",
      "specialities",
      "location",
    ]),
    accessLevel: "DoctorProfile",
  },
  {
    name: "doctor",
    model: Doctor,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    allPopulation: [{ path: "speciality" }],
    accessLevel: "Doctor",
  },
  {
    name: "galleryitem",
    model: GalleryItem,
    all: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "GalleryItem",
  },
  {
    name: "accesslevel",
    model: AccessLevel,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    onePopulation: { path: "admins", populate: { path: "user" } },
    editBodyMutator: autoController.mutateCompoundFields(["$set"]),
  },
  {
    name: "useraccesslevel",
    model: UserAccessLevel,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    allPopulation: [{ path: "user" }, { path: "accessLevel" }],
  },
  {
    name: "clinic",
    model: Clinic,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "Clinic",
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
    editBodyMutator: autoController.mutateCompoundFields([
      "tags",
      "insurances",
      "services",
      "certificates",
      "location",
    ]),
  },
  {
    name: "clinicdepartment",
    model: ClinicDepartment,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "ClinicDepartment",
    allPopulation: { path: "doctorsCount" },
  },
  {
    name: "clinicdoctor",
    model: ClinicDoctor,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "ClinicDoctor",
    allPopulation: [{ path: "doctor" }, { path: "department" }],
  },
  {
    name: "doctorjoinclinic",
    model: DoctorJoinClinicRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    accessLevel: "DoctorJoinClinic",
    allPopulation: [{ path: "doctor" }, { path: "clinic" }],
  },
  {
    name: "clinicaddition",
    model: ClinicAdditionRequest,
    accessLevel: "ClinicAdditionRequest",
    all: true,
    one: true,
    edit: true,
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: { path: "submittedBy" },
  },
  {
    name: "hospitaldepartment",
    model: HospitalDepartment,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "HospitalDepartment",
    allPopulation: { path: "doctorsCount" },
  },
  {
    name: "hospitaldoctor",
    model: HospitalDoctor,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "HospitalDoctor",
    allPopulation: [{ path: "doctor" }, { path: "department" }],
  },
  {
    name: "doctorjoinhospital",
    model: DoctorJoinHospitalRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    accessLevel: "DoctorJoinHospital",
    allPopulation: [{ path: "doctor" }, { path: "hospital" }],
  },
  {
    name: "hospitaladdition",
    model: HospitalAdditionRequest,
    accessLevel: "HospitalAdditionRequest",
    all: true,
    one: true,
    edit: true,
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: { path: "submittedBy" },
  },
  {
    // doctors' "add my pharmacy" requests - had no admin section at all
    name: "pharmacyaddition",
    model: PharmacyAdditionRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: { path: "submittedBy" },
  },
  {
    name: "insurance",
    model: Insurance,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "Insurance",
    editBodyMutator: autoController.mutateCompoundFields([
      "insurances",
      "tags",
      "location",
      "coverages",
      "advantages",
    ]),
  },
  {
    // Mirrors hospitaladdition above - doctor-submitted requests to add a
    // new insurance provider to the platform (2026-09). See
    // Models/InsuranceAdditionRequest.ts.
    name: "insuranceaddition",
    model: InsuranceAdditionRequest,
    accessLevel: "InsuranceAdditionRequest",
    all: true,
    one: true,
    edit: true,
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: { path: "submittedBy" },
  },
  {
    name: "pharmacy",
    model: Pharmacy,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "Pharmacy",
    editBodyMutator: autoController.mutateCompoundFields(["location"]),
  },
  {
    name: "callroom",
    model: CallRoom,
    // read-only: participants/status of a consultation are a privacy
    // boundary, so rooms are created and ended only through callService
    // (/admin/call/create, /admin/call/:id/end), never edited or deleted raw
    all: true,
    one: true,
    edit: false,
    remove: false,
    create: false,
    accessLevel: "CallRoom",
    allPopulation: { path: "participants" },
  },
  {
    name: "redirection",
    model: Redirection,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "Redirection",
  },
  {
    name: "shortlink",
    model: ShortLink,
    accessLevel: "ShortLink",
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
  },
  {
    name: "disease",
    model: Disease,
    accessLevel: "Disease",
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    onePopulation: [
      { path: "drugs" },
      { path: "sameAs" },
      { path: "specialities" },
      { path: "symptoms" },
    ],
    editBodyMutator: autoController.mutateCompoundFields([
      "symptoms",
      "specialities",
      "drugs",
      "sameAs",
    ]),
  },
  {
    name: "drug",
    model: Drug,
    accessLevel: "Drug",
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    // the form sends "similar drugs" as a JSON string
    editBodyMutator: autoController.mutateCompoundFields(["sameAs"]),
  },
  {
    name: "symptom",
    model: Symptom,
    accessLevel: "Symptom",
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "part" }, { path: "sameAs" }],
    editBodyMutator: autoController.mutateCompoundFields(["part", "sameAs"]),
  },
  {
    name: "part",
    model: Part,
    accessLevel: "Part",
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "doctorfaq",
    model: DoctorFaq,
    accessLevel: "DoctorFaq",
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
    allPopulation: [{ path: "doctor" }],
  },
  { name: "taminServiceType", model: TaminServiceType, all: true, edit: true },
  {
    name: "taminPrescriptionType",
    model: TaminPrescriptionType,
    all: true,
    edit: true,
  },
  { name: "taminService", model: TaminService, all: true, edit: true },
  { name: "taminParTaref", model: TaminParTaref, all: true, edit: true },
  { name: "taminDrugUsage", model: TaminDrugUsage, all: true, edit: true },
  {
    name: "taminDrugInstruction",
    model: TaminDrugInstruction,
    all: true,
    edit: true,
  },
  { name: "taminDrugAmount", model: TaminDrugAmount, all: true, edit: true },
  { name: "taminPhPlan", model: TaminPhPlan, all: true, edit: true },
  { name: "taminPhIllness", model: TaminPhIllness, all: true, edit: true },
  { name: "taminIcid", model: TaminIcid, all: true, edit: true },
  { name: "taminComplaint", model: TaminComplaint, all: true, edit: true },
  { name: "taminSpec", model: TaminSpec, all: true, edit: true },
  {
    name: "aiExample",
    model: AiExample,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
  },
  {
    name: "homeIntroduction",
    model: HomeIntroduction,
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
  },
  {
    name: "advertisement",
    model: Advertisement,
    all: true,
    create: true,
    one: true,
    edit: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields(["positions"]),
  },
  {
    name: "service",
    model: Service,
    all: true,
    create: true,
    one: true,
    edit: true,
    remove: true,
    allPopulation: [{ path: "owner" }, { path: "category" }],
    onePopulation: { path: "owner" },
    editBodyMutator: autoController.mutateCompoundFields(["sameAs"]),
  },
  {
    name: "faq",
    model: Faq,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
    allPopulation: [{ path: "category" }],
  },
  { name: "ollamaModel", model: OllamaModel, all: true },
  {
    name: "globalOllamaSettings",
    model: GlobalOllamaSettings,
    singleton: true,
    all: true,
    edit: true,
    allPopulation: { path: "defaultModel" },
  },
  {
    // Runtime configuration that used to live only in .env (SIP creds,
    // Podium API keys, booking/analytics/reservation/call tuning values) -
    // see Models/AppConfig.ts and Lib/appConfig.ts. No accessLevel set on
    // purpose: only the "admin" role (not "notadmin") can read/write this.
    name: "appConfig",
    model: AppConfig,
    singleton: true,
    edit: true,
  },
  {
    // IPPanel SMS gateway pattern codes (Lib/sendSms.ts / Lib/smsPatterns.ts)
    // - see Models/SmsPatterns.ts. No accessLevel set on purpose, mirroring
    // appConfig above: only the "admin" role (not "notadmin") can read/write
    // this.
    name: "smsPatterns",
    model: SmsPatterns,
    singleton: true,
    edit: true,
  },
  {
    name: "botInstruction",
    model: BotInstruction,
    all: true,
    create: true,
    edit: true,
    remove: true,
    one: true,
  },
  {
    name: "serviceCategory",
    model: ServiceCategory,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
  },
  {
    name: "province",
    model: Province,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
  },
  {
    name: "city",
    model: City,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
  },
  {
    name: "district",
    model: District,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
  },
  {
    name: "becomeParaClinic",
    model: BecomeParaClinicRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: becomeStatusEditSchema,
  },
  {
    name: "paraClinic",
    model: ParaClinic,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
    editBodyMutator: autoController.mutateCompoundFields([
      "tags",
      "location",
      "insurances",
    ]),
  },
  {
    name: "productCategory",
    model: ProductCategory,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
  },
  {
    name: "Product",
    model: Product,
    all: true,
    edit: true,
    one: true,
    create: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields(["sameAs"]),
  },
  {
    name: "productImage",
    model: ProductImage,
    all: true,
    edit: true,
    one: true,
    create: true,
    remove: true,
  },
  {
    name: "productSeller",
    model: ProductSeller,
    all: true,
    edit: true,
    one: true,
    create: true,
    remove: true,
    allPopulation: { path: "seller" },
  },
  {
    name: "productSpec",
    model: ProductSpec,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
  },
  {
    name: "clinicCategory",
    model: ClinicCategory,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "diseaseCategory",
    model: DiseaseCategory,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "diseaseTag",
    model: DiseaseTag,
    all: true,
    edit: true,
    one: true,
    create: true,
    remove: true,
  },
  {
    name: "drugTag",
    model: DrugTag,
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
  },
  {
    name: "specialityCategory",
    model: SpecialityCategory,
    // same rights as the specialities it groups (it was admin-only, so a
    // staff member with speciality rights got 403 on the category picker)
    accessLevel: "Sepciality",
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
  },
  {
    name: "clinicTag",
    model: ClinicTag,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
  },
  {
    name: "hospital",
    model: Hospital,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
    accessLevel: "Hospital",
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
    editBodyMutator: autoController.mutateCompoundFields([
      "tags",
      "location",
      "services",
      "insurances",
      "certificates",
    ]),
  },
  {
    name: "hospitalCategory",
    model: HospitalCategory,
    all: true,
    edit: true,
    one: true,
    remove: true,
    create: true,
  },
  {
    name: "hospitalTag",
    model: HospitalTag,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "test",
    model: Test,
    all: true,
    edit: true,
    one: true,
    remove: true,
    create: true,
  },
  {
    name: "testCategory",
    model: TestCategory,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "paraClinicTest",
    model: ParaClinicTest,
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
    allPopulation: { path: "test" },
  },
  {
    name: "paraClinicCategory",
    model: ParaClinicCategory,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "paraClinicTag",
    model: ParaClinicTag,
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
  },
  {
    name: "servicePackage",
    model: ServicePackage,
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
    allPopulation: { path: "owner" },
    editBodyMutator: autoController.mutateCompoundFields(["services"]),
  },
  {
    name: "productPackage",
    model: ProductPackage,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
    allPopulation: { path: "owner" },
    editBodyMutator: autoController.mutateCompoundFields([
      "products",
      "sameAs",
    ]),
  },
  {
    name: "symptomCategory",
    model: SymptomCategory,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  // Verified visit reviews of doctors (2026-09): admins approve / reject
  // them before they go public. Only the status is editable - the text is
  // the patient's own words and isn't rewritten by staff.
  {
    name: "doctorFeedback",
    model: DoctorFeedBack,
    all: true,
    one: true,
    edit: true,
    remove: true,
    editSchema: z.strictObject({ status: z.enum(doctorFeedbackStatuses) }),
    allPopulation: [
      { path: "doctor", select: "firstName lastName slug" },
      { path: "user", select: "phone" },
      { path: "reservation", select: "date start sessionType" },
    ],
    onePopulation: [
      { path: "doctor", select: "firstName lastName slug" },
      { path: "user", select: "phone" },
      { path: "reservation", select: "date start sessionType" },
    ],
  },
  {
    name: "comment",
    model: Comment,
    all: true,
    edit: true,
    remove: true,
    one: true,
    accessLevel: "Comment",
    // moderation only: an admin approves or rejects what a user wrote, and
    // never rewrites it (or posts one in someone's name)
    editSchema: z.strictObject({
      status: z.enum(["Pending", "Approved", "Rejected"]),
    }),
    allPopulation: [{ path: "author" }, { path: "resource" }],
    onePopulation: [
      { path: "author" },
      { path: "resource" },
      { path: "upvotes" },
    ],
  },
  {
    name: "hospitalClinic",
    model: HospitalClinic,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
    allPopulation: { path: "clinic" },
  },
  {
    name: "insuranceCategory",
    model: InsuranceCategory,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "insuranceTag",
    model: InsuranceTag,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "insurancePlan",
    model: InsurancePlan,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields(["features"]),
  },
  {
    name: "faqCategory",
    model: FaqCategory,
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
  },
  {
    name: "contactRequest",
    model: ContactRequest,
    all: true,
    edit: true,
    remove: true,
    one: true,
  },
  {
    name: "privacySection",
    model: PrivacySection,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "aboutPartner",
    model: AboutPartner,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
  },
  {
    name: "aboutTeam",
    model: AboutTeam,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "aboutWhy",
    model: AboutWhy,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "testify",
    model: Testify,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "pageMeta",
    model: PageMeta,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields([
      "keywords",
      "webSchema",
    ]),
  },
  {
    name: "ticket",
    model: Ticket,
    all: true,
    one: true,
    edit: true,
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: [{ path: "submittedBy" }, { path: "messages" }],
  },
  {
    name: "ticketmessage",
    model: TicketMessage,
    all: true,
    one: true,
    create: true,
    remove: true,
  },
  {
    name: "notification",
    model: Notification,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: [{ path: "user" }, { path: "createdBy" }],
    onePopulation: [{ path: "user" }, { path: "createdBy" }],
  },
  // Read-only(ish) admin visibility into who has web push enabled, for the
  // "Test push notifications" admin page - subscriptions themselves are
  // only ever created via /user/push/subscribe (see userController.ts).
  // remove is allowed so an admin can clear a stale/duplicate one while
  // testing, same as PushSubscription.deleteOne on a 404/410 delivery
  // failure in Services/pushNotificationService.ts.
  {
    name: "pushsubscription",
    model: PushSubscription,
    all: true,
    remove: true,
    allPopulation: { path: "user" },
  },
  {
    name: "blogTag",
    model: BlogTag,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
  },
  { name: "blogRrs", model: BlogRRS, all: true },
  {
    // Per-pharmacy commission rate (2026-08) - see
    // Models/PharmacyFinanceSettings.ts. One doc per pharmacy (unique on
    // `pharmacy`); a pharmacy with no doc here falls back to
    // globalFinanceSettings.defaultPharmacyCommissionPercent below. Sibling
    // entries below for doctor/paraClinic. No accessLevel set on purpose,
    // matching appConfig: only the "admin" role (not "notadmin") can
    // read/write commission rates.
    name: "pharmacyFinanceSettings",
    model: PharmacyFinanceSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "pharmacy" },
    onePopulation: { path: "pharmacy" },
  },
  {
    name: "doctorFinanceSettings",
    model: DoctorFinanceSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "doctor" },
    onePopulation: { path: "doctor" },
  },
  {
    name: "paraClinicFinanceSettings",
    model: ParaClinicFinanceSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "paraClinic" },
    onePopulation: { path: "paraClinic" },
  },
  {
    // Platform-wide default commission rates (2026-08) - see
    // Models/GlobalFinanceSettings.ts. Fallback used when an organization
    // has no *FinanceSettings doc of its own above.
    name: "globalFinanceSettings",
    model: GlobalFinanceSettings,
    singleton: true,
    edit: true,
  },
  {
    // Per-pharmacy tax rate (2026-09) - see Models/PharmacyTaxSettings.ts.
    // One doc per pharmacy (unique on `pharmacy`); a pharmacy with no doc
    // here falls back to globalTaxSettings.defaultPharmacyTaxPercent below.
    // Sibling entries below for doctor/clinic/paraClinic. No accessLevel
    // set on purpose, matching pharmacyFinanceSettings above: only the
    // "admin" role (not "notadmin") can read/write tax rates - regular
    // buyers only ever see the already-resolved effective rate via
    // Lib/taxSettings.ts, never this admin CRUD surface directly.
    name: "pharmacyTaxSettings",
    model: PharmacyTaxSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "pharmacy" },
    onePopulation: { path: "pharmacy" },
  },
  {
    name: "doctorTaxSettings",
    model: DoctorTaxSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "doctor" },
    onePopulation: { path: "doctor" },
  },
  {
    // Clinic owns no sellable/payable item today - see
    // Models/ClinicTaxSettings.ts's comment. Registered the same as its
    // siblings for admin-UI parity (2026-09 user decision), even though
    // nothing reads this via Lib/taxSettings.ts yet.
    name: "clinicTaxSettings",
    model: ClinicTaxSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "clinic" },
    onePopulation: { path: "clinic" },
  },
  {
    name: "paraClinicTaxSettings",
    model: ParaClinicTaxSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "paraClinic" },
    onePopulation: { path: "paraClinic" },
  },
  {
    // Platform-wide default tax rates (2026-09) - see
    // Models/GlobalTaxSettings.ts. Fallback used when an organization has no
    // *TaxSettings doc (or, for doctor, no value on the relevant field) of
    // its own above.
    name: "globalTaxSettings",
    model: GlobalTaxSettings,
    singleton: true,
    edit: true,
  },
  {
    // Doctor license/subscription tiers (2026-09) - see
    // Models/BaseDoctorLicense.ts. Flat admin-managed catalog, not tied to
    // a single doctor.
    name: "baseDoctorLicense",
    model: BaseDoctorLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields([
      "descriptions",
      "modules",
      "pricing",
    ]),
  },
  {
    // Per-doctor license record (2026-09) - see
    // Models/DoctorProfileLicense.ts. One doc per doctor (unique on
    // `owner`), fetched by the admin doctor-profile "License" tab via
    // GET /auto/doctorProfileLicense?owner=<doctorProfileId>, same pattern
    // as doctorFinanceSettings above.
    name: "doctorProfileLicense",
    model: DoctorProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: autoController.mutateCompoundFields(["modules"]),
  },
  {
    // Pharmacy license/subscription tiers (2026-09) - see
    // Models/BasePharmacyLicense.ts. Flat admin-managed catalog, not tied to
    // a single pharmacy. Mirrors baseDoctorLicense above.
    name: "basePharmacyLicense",
    model: BasePharmacyLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields([
      "descriptions",
      "modules",
      "pricing",
    ]),
  },
  {
    // Per-pharmacy license record (2026-09) - see
    // Models/PharmacyProfileLicense.ts. One doc per pharmacy (unique on
    // `owner`), fetched by the admin pharmacy-profile "License" tab via
    // GET /auto/pharmacyProfileLicense?owner=<pharmacyId>, mirrors
    // doctorProfileLicense above.
    name: "pharmacyProfileLicense",
    model: PharmacyProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: autoController.mutateCompoundFields(["modules"]),
  },
  {
    // Clinic license/subscription tiers (2026-09) - see
    // Models/BaseClinicLicense.ts. Flat admin-managed catalog, not tied to a
    // single clinic. Mirrors baseDoctorLicense/basePharmacyLicense above.
    name: "baseClinicLicense",
    model: BaseClinicLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields([
      "descriptions",
      "modules",
      "pricing",
    ]),
  },
  {
    // Per-clinic license record (2026-09) - see
    // Models/ClinicProfileLicense.ts. One doc per clinic (unique on
    // `owner`), fetched by the admin clinic-profile "License" tab via
    // GET /auto/clinicProfileLicense?owner=<clinicId>, mirrors
    // doctorProfileLicense/pharmacyProfileLicense above.
    name: "clinicProfileLicense",
    model: ClinicProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: autoController.mutateCompoundFields(["modules"]),
  },
  {
    // Hospital license/subscription tiers (2026-09) - see
    // Models/BaseHospitalLicense.ts. Flat admin-managed catalog, not tied to
    // a single hospital. Mirrors baseDoctorLicense/basePharmacyLicense/
    // baseClinicLicense above.
    name: "baseHospitalLicense",
    model: BaseHospitalLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields([
      "descriptions",
      "modules",
      "pricing",
    ]),
  },
  {
    // Per-hospital license record (2026-09) - see
    // Models/HospitalProfileLicense.ts. One doc per hospital (unique on
    // `owner`), fetched by the admin hospital-profile "License" tab via
    // GET /auto/hospitalProfileLicense?owner=<hospitalId>, mirrors
    // doctorProfileLicense/pharmacyProfileLicense/clinicProfileLicense above.
    name: "hospitalProfileLicense",
    model: HospitalProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: autoController.mutateCompoundFields(["modules"]),
  },
  {
    // Insurance license/subscription tiers (2026-09) - see
    // Models/BaseInsuranceLicense.ts. Flat admin-managed catalog, not tied
    // to a single insurance. Mirrors baseHospitalLicense above.
    name: "baseInsuranceLicense",
    model: BaseInsuranceLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields([
      "descriptions",
      "modules",
      "pricing",
    ]),
  },
  {
    // Per-insurance license record (2026-09) - see
    // Models/InsuranceProfileLicense.ts. One doc per insurance (unique on
    // `owner`), fetched by the admin insurance-profile "License" tab via
    // GET /auto/insuranceProfileLicense?owner=<insuranceId>, mirrors
    // hospitalProfileLicense above.
    name: "insuranceProfileLicense",
    model: InsuranceProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: autoController.mutateCompoundFields(["modules"]),
  },
  {
    // ParaClinic license/subscription tiers (2026-09) - see
    // Models/BaseParaClinicLicense.ts. Flat admin-managed catalog, not tied
    // to a single paraClinic. Mirrors
    // baseDoctorLicense/basePharmacyLicense/baseClinicLicense above.
    name: "baseParaClinicLicense",
    model: BaseParaClinicLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields([
      "descriptions",
      "modules",
      "pricing",
    ]),
  },
  {
    // Per-paraClinic license record (2026-09) - see
    // Models/ParaClinicProfileLicense.ts. One doc per paraClinic (unique on
    // `owner`), fetched by the admin paraClinic-profile "License" tab via
    // GET /auto/paraClinicProfileLicense?owner=<paraClinicId>, mirrors
    // doctorProfileLicense/pharmacyProfileLicense/clinicProfileLicense
    // above.
    name: "paraClinicProfileLicense",
    model: ParaClinicProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: autoController.mutateCompoundFields(["modules"]),
  },
  {
    // Per-staff-account (role !== "user", i.e. "admin"/"notadmin") alert
    // preferences (2026-09) - see Models/UserAlert.ts. One doc per user
    // (unique on `user`). No accessLevel set on purpose, matching
    // notification/appConfig above: only the "admin" role manages who gets
    // alerted about what.
    name: "userAlert",
    model: UserAlert,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
  },
  {
    // Reusable catalog of license duration options (2026-09) - see
    // Models/LicenseDuration.ts. Flat admin-managed lookup, not tied to a
    // single organization type, mirrors clinicCategory/faqCategory above.
    name: "licenseDuration",
    model: LicenseDuration,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
  },
  {
    // Singleton bucket of static image slots used around the app (2026-09) -
    // see Models/StaticImages.ts. Field names (homeMain/onboardingMain/
    // onboadingSecurity/...) are declared in that file's staticImageFields
    // array; each is a plain String path saved via uploadController's
    // saveUplaodsToBody, same upload flow as every other `image` field. No
    // accessLevel set on purpose, matching globalFinanceSettings/
    // globalTaxSettings/smsPatterns above: only the "admin" role manages it.
    name: "staticImages",
    model: StaticImages,
    singleton: true,
    edit: true,
  },
  {
    // Per-segment booking descriptions shown in the booking flow (2026-09) -
    // see Models/BookingDescription.ts. Flat admin-managed list, ordered and
    // filtered by `segment`. No accessLevel set on purpose, mirroring
    // aboutWhy/homeIntroduction above.
    name: "bookingDescription",
    model: BookingDescription,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
  },
];

registerAuditSingletons(map.filter((s) => s.singleton).map((s) => s.name));

const withAccessLevelRoles = ["admin", "notadmin"] as const;
const noAccessLevelRoles = ["admin"] as const;

// DB-content translations (see contentTranslationController). Registered
// before the generic routes so "/<segment>/_translations" is not taken for
// a nodeId.
const translationSegments = map.filter(
  (segment) =>
    !segment.singleton && contentTranslationController.fieldsOf(segment.model),
);

router
  .route("/_translations")
  .get(
    authController.protect,
    authController.restrictTo(...withAccessLevelRoles),
    contentTranslationController.getOverview(translationSegments),
  );
router
  .route("/_translations/bulk")
  .all(authController.protect, authController.restrictTo(...noAccessLevelRoles))
  .get(contentTranslationController.bulkStatus)
  .post(contentTranslationController.startBulk(translationSegments))
  .delete(contentTranslationController.stopBulk);

for (const segment of translationSegments) {
  const guard = (op: "readAll" | "readOne" | "update") => [
    authController.protect,
    authController.restrictTo(
      ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
    ),
    ...(segment.accessLevel
      ? [authController.hasPermission({ model: segment.accessLevel, op })]
      : []),
  ];
  router
    .route(`/${segment.name}/_translations`)
    .get(...guard("readAll"), contentTranslationController.listRecords(segment));
  router
    .route(`/${segment.name}/:nodeId/_translations`)
    .get(...guard("readOne"), contentTranslationController.getRecord(segment))
    .post(...guard("update"), contentTranslationController.saveRecord(segment));
  router
    .route(`/${segment.name}/:nodeId/_translations/auto`)
    .post(
      ...guard("update"),
      contentTranslationController.autoTranslateRecord(segment),
    );
}

for (let i = 0; i < map.length; i++) {
  const segment = map[i];
  if (segment.singleton) {
    router.route(`/${segment.name}`).get(
      authController.protect,
      authController.restrictTo(
        ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
      ),
      ...(segment.accessLevel
        ? [
            authController.hasPermission({
              model: segment.accessLevel,
              op: "readOne",
            }),
          ]
        : []),
      ...(segment.querySchema
        ? [autoController.validateQuery(segment.querySchema)]
        : []),
      autoController.getSingleton({
        model: segment.model,
        pop: segment.allPopulation,
      }),
    );
    if (segment.edit)
      router.route(`/${segment.name}`).post(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "update",
              }),
            ]
          : []),
        uploadController.upload.any(),
        uploadController.saveUplaodsToBody({ name: segment.name }),
        ...(segment.editBodyMutator ? [segment.editBodyMutator] : []),
        ...(segment.editSchema
          ? [autoController.validateBody(segment.editSchema)]
          : []),
        autoController.editSingleton({ model: segment.model }),
      );
  } else {
    if (segment.all)
      router.route(`/${segment.name}`).get(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "readAll",
              }),
            ]
          : []),
        ...(segment.querySchema
          ? [autoController.validateQuery(segment.querySchema)]
          : []),
        autoController.getAll({
          model: segment.model,
          population: segment.allPopulation,
          selection: segment.allSelection,
        }),
      );
    if (segment.create)
      router.route(`/${segment.name}`).post(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "write",
              }),
            ]
          : []),
        uploadController.upload.any(),
        uploadController.saveUplaodsToBody({ name: segment.name }),
        ...(segment.editBodyMutator ? [segment.editBodyMutator] : []),
        ...(segment.editSchema
          ? [autoController.validateBody(segment.editSchema)]
          : []),
        autoController.create({ model: segment.model }),
      );
    if (segment.one)
      router.route(`/${segment.name}/:nodeId`).get(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "readOne",
              }),
            ]
          : []),
        ...(segment.querySchema
          ? [autoController.validateQuery(segment.querySchema)]
          : []),
        autoController.getOne({
          model: segment.model,
          pop: segment.onePopulation,
        }),
      );
    if (segment.edit)
      router.route(`/${segment.name}/:nodeId`).post(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "update",
              }),
            ]
          : []),
        uploadController.upload.any(),
        uploadController.saveUplaodsToBody({ name: segment.name }),
        ...(segment.editBodyMutator ? [segment.editBodyMutator] : []),
        ...(segment.editSchema
          ? [autoController.validateBody(segment.editSchema)]
          : []),
        autoController.edit({ model: segment.model }),
      );
    if (segment.remove)
      router.route(`/${segment.name}/:nodeId`).put(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "delete",
              }),
            ]
          : []),
        autoController.remove({
          model: segment.model,
          guard: segment.removeGuard,
        }),
      );
  }
}

export default router;
