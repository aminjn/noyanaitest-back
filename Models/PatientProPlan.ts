import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { translatable } from "../Lib/i18n/translatable";
import { IBaseLicensePricing, BaseLicensePricingSchema } from "./BaseLicensePricing";
import { ticketPriorities, TicketPriority } from "./Ticket";

// «پرو» (2026-10, owner request): the paid membership of regular users
// (patients). One plan, managed by the super admin under «پلن‌ها و مجوزها ←
// اشتراک پرو کاربران» (Controllers/patientProController.ts). Like Amazon One
// Medical's / K Health's membership and Practo Plus: a monthly, quarterly
// or yearly price (the same price options as a provider plan,
// Models/BaseLicensePricing.ts, so the launch-promotion engine of
// Lib/licenseQuote.ts prices it too - kind "patient") and a set of benefits
// built only on what the site already does. Every benefit is enforced on
// the server (Lib/patientPro.ts) and each has its own switch here.
//
// The fields are flat (not nested benefit objects) so the admin form
// (CreateForm) edits them directly.
export interface IPatientProPlan extends MongoDoc {
  displayName: string;
  summary: string;
  // on sale (false: nobody can buy; running memberships keep their benefits
  // until they end)
  isActive: boolean;
  order: number;
  pricing: IBaseLicensePricing[];

  // ---- the AI health assistant (/wizard, Controllers/botController.ts)
  // messages a day for everyone without Pro (0 = no limit); the free tier's
  // cost control, applied whether Pro is on sale or not
  freeAiDailyLimit: number;
  aiEnabled: boolean;
  // a Pro member's daily messages (0 = unlimited; a high number is a
  // fair-use cap)
  proAiDailyLimit: number;

  // ---- discount on doctor visits booked online (Controllers/
  // bookingController.ts). Funded by the platform out of its commission:
  // the doctor's payout never changes (Services/reservationProgressService
  // .ts pays on the undiscounted price; the platform books the discount as
  // marketing expense, Lib/business/ledgerPoster.ts)
  bookingDiscountEnabled: boolean;
  bookingDiscountPercent: number;
  // toman cap per visit (0 = no cap)
  bookingDiscountMax: number;
  // never more than the platform's own commission on that visit, so a
  // visit never costs the platform money (in-person visits carry 0%
  // commission by default and then get no discount)
  bookingDiscountCapAtCommission: boolean;
  // the discount also on visits the member books for family members added
  // under «بستگان» (UserRelative)
  familyEnabled: boolean;

  // ---- pharmacy delivery (Lib/delivery.ts, Tapsi same-city courier fee)
  deliveryEnabled: boolean;
  // order subtotal (toman, before tax) from which the discount applies
  // (0 = every order)
  deliveryFreeAbove: number;
  // percent of the courier fee the platform pays (100 = free delivery);
  // the pharmacy still receives the whole fee
  deliveryPercentOff: number;

  // ---- free cancellation (Services/reservationCancelService.ts)
  cancelEnabled: boolean;
  // a member may cancel online for free up to this many hours before the
  // visit (everyone else: AppConfig.patientFreeCancelHours)
  proFreeCancelHours: number;

  // ---- support (Controllers/supportController.ts submitTicket)
  supportEnabled: boolean;
  supportPriority: TicketPriority;
}

const PatientProPlanSchema = new mongoose.Schema<IPatientProPlan, Model<IPatientProPlan>>(
  {
    displayName: { type: String, default: "پرو", trim: true, maxlength: 60 },
    summary: { type: String, default: "", maxlength: 500 },
    isActive: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    pricing: { type: [BaseLicensePricingSchema], default: [] },
    freeAiDailyLimit: { type: Number, default: 20, min: 0, max: 10000 },
    aiEnabled: { type: Boolean, default: true },
    proAiDailyLimit: { type: Number, default: 0, min: 0, max: 100000 },
    bookingDiscountEnabled: { type: Boolean, default: true },
    bookingDiscountPercent: { type: Number, default: 10, min: 0, max: 100 },
    bookingDiscountMax: { type: Number, default: 100_000, min: 0 },
    bookingDiscountCapAtCommission: { type: Boolean, default: true },
    familyEnabled: { type: Boolean, default: true },
    deliveryEnabled: { type: Boolean, default: true },
    deliveryFreeAbove: { type: Number, default: 300_000, min: 0 },
    deliveryPercentOff: { type: Number, default: 100, min: 0, max: 100 },
    cancelEnabled: { type: Boolean, default: true },
    proFreeCancelHours: { type: Number, default: 6, min: 0, max: 168 },
    supportEnabled: { type: Boolean, default: true },
    supportPriority: { type: String, enum: ticketPriorities, default: "high" },
  },
  { timestamps: true },
);

PatientProPlanSchema.plugin(translatable);

const PatientProPlan = mongoose.model("PatientProPlan", PatientProPlanSchema);

export default PatientProPlan;
