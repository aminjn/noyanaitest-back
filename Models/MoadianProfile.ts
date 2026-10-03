import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One taxpayer's Moadian (سامانه‌ی مودیان) link (2026-10, Lib/moadian):
// the provider's, or Noyan's own (ownerKind "platform"). Noyan makes the
// taxpayer's RSA key pair; the taxpayer registers its public key (or the
// certificate request) in the Moadian portal, chooses "direct sending" and
// copies the memory id the portal gives back. From then on every paid
// visit or sale is invoiced and sent with the taxpayer's own signature.
// The private key is sealed at rest (Lib/moadian/jose.ts) and never leaves
// the server.

export const moadianEnvs = ["sandbox", "production"] as const;
export const moadianTaxpayerTypes = ["natural", "legal"] as const;
// what each kind of line is invoiced as: the 13-digit stuff/service id from
// the tax organisation's list
export const moadianItemKinds = [
  "visit",
  "service",
  "test",
  "product",
  "package",
  "shipping",
  "commission",
  "subscription",
  "sms",
] as const;
export type MoadianItemKind = (typeof moadianItemKinds)[number];

export interface IMoadianProfile extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  isActive: boolean;
  // invoices are made for what happens from this moment on
  activeFrom?: Date;
  env: (typeof moadianEnvs)[number];
  taxpayerType: (typeof moadianTaxpayerTypes)[number];
  name?: string;
  // national id (natural person, 10 digits), national id of the company
  // (11) or economic code (14)
  economicCode?: string;
  postalCode?: string;
  memoryId?: string;
  privateKey?: string;
  publicKey?: string;
  csr?: string;
  certificate?: string;
  keyCreatedAt?: Date;
  // the last serial used (the tax id's serial part)
  serial: number;
  sstid: Partial<Record<MoadianItemKind, string>>;
  // measuring unit code for one service or one item
  unit: string;
  // Noyan's own services (platform only): VAT percent inside the price
  vatPercent: number;
  lastError?: string;
  lastErrorAt?: Date;
  lastSentAt?: Date;
  // platform only: the last Jalali month ("1405-06") whose commission
  // invoices were made
  commissionDoneFor?: string;
}

const MoadianProfileSchema = new mongoose.Schema<IMoadianProfile, Model<IMoadianProfile>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    isActive: { type: Boolean, default: false },
    activeFrom: { type: Date },
    env: { type: String, enum: moadianEnvs, default: "production" },
    taxpayerType: { type: String, enum: moadianTaxpayerTypes, default: "natural" },
    name: { type: String, trim: true, maxlength: 200 },
    economicCode: { type: String, trim: true, maxlength: 14 },
    postalCode: { type: String, trim: true, maxlength: 10 },
    memoryId: { type: String, trim: true, uppercase: true, maxlength: 6 },
    privateKey: { type: String, select: false },
    publicKey: { type: String },
    csr: { type: String },
    certificate: { type: String, maxlength: 20000 },
    keyCreatedAt: { type: Date },
    serial: { type: Number, default: 0, min: 0 },
    sstid: {
      type: Object.fromEntries(moadianItemKinds.map((k) => [k, { type: String, trim: true, maxlength: 13 }])),
      default: {},
    },
    unit: { type: String, trim: true, default: "1627", maxlength: 8 },
    vatPercent: { type: Number, default: 10, min: 0, max: 100 },
    lastError: { type: String, maxlength: 500 },
    lastErrorAt: { type: Date },
    lastSentAt: { type: Date },
    commissionDoneFor: { type: String },
  },
  { timestamps: true },
);

MoadianProfileSchema.index({ ownerKind: 1, ownerId: 1 }, { unique: true });

const MoadianProfile = mongoose.model("MoadianProfile", MoadianProfileSchema);

export default MoadianProfile;
