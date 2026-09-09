import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IDoctorProfile } from "./DoctorProfile";

export const doctorActions = [
  "readClinics",
  "leaveClinics",
  "joinClinic",
  "mutateJoinClinic",
  "clinicAddition",
  // Hospital counterpart of the clinic actions above (2026-09) - one doctor
  // dashboard, both org types. Kept in sync with
  // Components/Enums/actions/doctorActions.tsx on noyanai-front.
  "readHospitals",
  "leaveHospitals",
  "joinHospital",
  "mutateJoinHospital",
  "hospitalAddition",
  "readCalendar",
  "mutateCalendar",
  "readSettings",
  "mutateSettings",
  "readInsurance",
  "mutateInsurance",
  "insuranceAddition",
  "readPharmacy",
  "mutatePharmacy",
  "pharmacyAddition",
  "mutateProfile",
  "readPatients",
  "readPatient",
  "mutatePatient",
  "readGallery",
  "mutateGallery",
  "readOffices",
  "mutateOffices",
  "readSocial",
  "mutateSocial",
  "readFaq",
  "mutateFaq",
  "readServices",
  "mutateServices",
  "readServicePackages",
  "mutateServicePackages",
  // Sidebar-gating actions (2026-08) — one per DoctorSidebar nav item that
  // isn't a baseline (always-visible) page or the secretary-management item
  // itself (which stays owner-only by design). Kept in sync with
  // Components/Enums/actions/doctorActions.tsx on noyanai-front.
  "readFinance",
  "readShifts",
  "readSchedule",
  "readLicenses",
  "readOffers",
  "readDiscounts",
  "readArticles",
  "readChat",
  "readDrugs",
  "readDocuments",
  // Incoming-orders page (2026-08) — doctorpanel/order, listing Order docs
  // that include this doctor's services/servicePackages. Kept in sync with
  // Components/Enums/actions/doctorActions.tsx on noyanai-front.
  "readOrders",
  // Incoming-order detail page (2026-08) — doctorpanel/order/:nodeId,
  // fulfilling/cancelling this doctor's own line items within an order.
  // Kept in sync with Components/Enums/actions/doctorActions.tsx on
  // noyanai-front.
  "mutateOrders",
] as const;

export type DoctorAction = (typeof doctorActions)[number];

export type IDoctorAcl = Acl<typeof doctorActions, IDoctorProfile>;

const DoctorAclSchema = aclSchema(doctorActions, "DoctorProfile");

const DoctorAcl = mongoose.model("DoctorAcl", DoctorAclSchema);

export default DoctorAcl;
