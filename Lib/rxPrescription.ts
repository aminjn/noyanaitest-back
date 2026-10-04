import mongoose, { isValidObjectId } from "mongoose";
import z from "zod";
import { isSSID } from "./validators";

// Prescription-only products in the pharmacy marketplace (2026-10).
//
// The pattern of Halodoc / Vezeeta / DrDr / Digikala Pharmacy: an Rx item can
// sit in the cart, but checkout asks for a prescription - here either an
// Iranian e-prescription (Tamin / Salamat «کد رهگیری نسخه» + the patient's
// national code) or a photo of the paper prescription. It is stored on each
// Rx order line (Models/Order.ts `prescription`), and the selling pharmacy
// confirms it (or rejects it with a reason, which refunds the line through
// Services/orderSettlementService.ts) before the line can be fulfilled.
//
// The Tamin pharmacy lookup (pharmacyController.getPatientPrescriptions) is
// locked out for end users and bound to a test pharmacy id, so the pharmacy
// checks the code in its own Tamin / NRX panel; when that lookup is opened,
// it can be called with the stored trackingCode + nationalCode.

export const rxInsurers = ["tamin", "salamat", "other"] as const;
export type RxInsurer = (typeof rxInsurers)[number];

// erx   -> an electronic prescription's tracking code + national code
// paper -> photos / a PDF of the paper prescription (private UserFile)
export const rxKinds = ["erx", "paper"] as const;
export type RxKind = (typeof rxKinds)[number];

// pending  -> waiting for the pharmacy
// approved -> the pharmacy confirmed it; the line can now be fulfilled
// rejected -> the pharmacy refused it (reason given); the line is cancelled
//             and refunded at the same moment
export const rxReviewStatuses = ["pending", "approved", "rejected"] as const;
export type RxReviewStatus = (typeof rxReviewStatuses)[number];

export const RX_MAX_FILES = 3;

export interface IOrderLinePrescription {
  kind: RxKind;
  insurer?: RxInsurer;
  trackingCode?: string;
  nationalCode?: string;
  files?: mongoose.Types.ObjectId[];
  note?: string;
  status: RxReviewStatus;
  reason?: string;
  reviewedAt?: Date;
  reviewedBy?: mongoose.Types.ObjectId;
}

// Sub-schema shared by the products / productPackages lines of an order.
export const orderLinePrescriptionSchema = new mongoose.Schema<IOrderLinePrescription>(
  {
    kind: { type: String, enum: rxKinds, required: true },
    insurer: { type: String, enum: rxInsurers },
    trackingCode: { type: String, trim: true, maxlength: 40 },
    nationalCode: { type: String, trim: true, maxlength: 10 },
    files: [{ type: mongoose.Schema.ObjectId, ref: "UserFile" }],
    note: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: rxReviewStatuses, default: "pending", required: true },
    reason: { type: String, trim: true, maxlength: 1000 },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { _id: false },
);

// Persian / Arabic digits -> ASCII, spaces and dashes removed
export const normalizeDigits = (value: string) =>
  value
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[\s-]/g, "");

// What the checkout sends. The cart is submitted as multipart (upload.none),
// so the object may arrive as a JSON string.
export const checkoutPrescriptionSchema = z.preprocess(
  (val) => {
    if (typeof val !== "string") return val;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  },
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("erx"),
      insurer: z.enum(rxInsurers).optional().default("tamin"),
      trackingCode: z
        .string()
        .transform(normalizeDigits)
        .pipe(z.string().regex(/^[A-Za-z0-9]{4,40}$/)),
      nationalCode: z
        .string()
        .transform(normalizeDigits)
        .pipe(z.string().regex(/^\d{10}$/).refine((v) => isSSID(v))),
      note: z.string().trim().max(500).optional(),
    }),
    z.object({
      kind: z.literal("paper"),
      files: z
        .array(z.string().refine((v) => isValidObjectId(v)))
        .min(1)
        .max(RX_MAX_FILES),
      note: z.string().trim().max(500).optional(),
    }),
  ]),
);

export type CheckoutPrescription = z.infer<typeof checkoutPrescriptionSchema>;

// populate entry that makes Product's `requiresPrescription` virtual right
export const productRxPopulate = { path: "drug", select: "name slug prescriptionStatus" };

// Same rule as the Product virtual, for lean / plain objects.
export const productNeedsRx = (product: unknown): boolean => {
  if (!product || typeof product !== "object") return false;
  const p = product as {
    requiresPrescription?: unknown;
    prescriptionRequired?: string;
    drug?: unknown;
  };
  if (typeof p.requiresPrescription === "boolean") return p.requiresPrescription;
  if (p.prescriptionRequired === "rx") return true;
  if (p.prescriptionRequired === "otc") return false;
  const drug = p.drug as { prescriptionStatus?: string } | null | undefined;
  return !!drug && typeof drug === "object" && drug.prescriptionStatus === "rx";
};

// A pharmacy package needs a prescription when any product in it does.
export const packageNeedsRx = (pkg: unknown): boolean => {
  const products = (pkg as { products?: unknown[] } | null)?.products;
  return Array.isArray(products) && products.some(productNeedsRx);
};
