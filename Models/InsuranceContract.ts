import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// An insurer ↔ provider contract (2026-10, owner decision). Until now a
// doctor or a centre put an insurer on its "accepted" list by itself, so
// the site said "takes Tamin" with no word from Tamin. Like the in-network
// contracts of Zocdoc / Practo and the قرارداد of Paziresh24's insurers, a
// contract now has two sides and a lifecycle with one-way steps only:
//
//   provider requests / insurer invites -> Pending
//   Pending -> Active     (the other side confirms; the admin confirms for
//                          an insurer that has no panel: reviewer "admin")
//   Pending -> Rejected   (the other side, with a reason)
//   Pending -> Cancelled  (the side that asked withdraws it)
//   Active  -> Ended      (either side, with a reason and an end date; a
//                          future end date keeps it active until then;
//                          validUntil passing ends it too)
//
// Only an Active contract inside its validity counts as acceptance
// (Lib/insuranceContracts.ts effectiveContractFilter): the booking quote,
// the /book filter, the public counts and the insurer's network all read
// it. The old acceptance stores (DoctorInsurance, the centres' `insurances`
// arrays) are kept as the read model of the effective contracts, written
// only by Lib/insuranceContracts.ts.
export const contractProviderKinds = ["doctor", "clinic", "hospital", "paraClinic", "pharmacy"] as const;
export type ContractProviderKind = (typeof contractProviderKinds)[number];

export const contractStatuses = ["Pending", "Active", "Rejected", "Cancelled", "Ended"] as const;
export type ContractStatus = (typeof contractStatuses)[number];

export const contractSides = ["provider", "insurer", "admin"] as const;
export type ContractSide = (typeof contractSides)[number];

export const contractProviderModels: Record<ContractProviderKind, string> = {
  doctor: "DoctorProfile",
  clinic: "Clinic",
  hospital: "Hospital",
  paraClinic: "ParaClinic",
  pharmacy: "Pharmacy",
};

export interface IInsuranceContract extends MongoDoc {
  insurance: mongoose.Types.ObjectId;
  providerKind: ContractProviderKind;
  provider: mongoose.Types.ObjectId;
  providerModel: string;
  status: ContractStatus;
  // set while Pending or Active: one open contract per insurer and provider
  open?: boolean;
  // who asked (the other side decides)
  initiatedBy: ContractSide;
  // who decides a provider's request: the insurer, or the admin for an
  // insurer with no panel account
  reviewer: "insurer" | "admin";
  // a contract made from the old one-sided list on deploy
  source?: "migration" | "addition";
  note?: string;
  validFrom?: Date | null;
  validUntil?: Date | null;
  decidedAt?: Date;
  decidedBy?: ContractSide;
  rejectReason?: string;
  activatedAt?: Date;
  // a scheduled end (either side, a future date)
  endsAt?: Date | null;
  endedAt?: Date;
  endedBy?: ContractSide | "expiry";
  endReason?: string;
  // the read model (DoctorInsurance / `insurances`) holds this contract
  applied?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const InsuranceContractSchema = new mongoose.Schema<IInsuranceContract, Model<IInsuranceContract>>(
  {
    insurance: { type: mongoose.Schema.ObjectId, ref: "Insurance", required: true },
    providerKind: { type: String, enum: contractProviderKinds, required: true },
    provider: { type: mongoose.Schema.ObjectId, refPath: "providerModel", required: true },
    providerModel: { type: String, enum: Object.values(contractProviderModels), required: true },
    status: { type: String, enum: contractStatuses, default: "Pending", required: true },
    open: { type: Boolean },
    initiatedBy: { type: String, enum: contractSides, required: true },
    reviewer: { type: String, enum: ["insurer", "admin"], default: "insurer" },
    source: { type: String, enum: ["migration", "addition"] },
    note: { type: String, maxlength: 500 },
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    decidedAt: { type: Date },
    decidedBy: { type: String, enum: contractSides },
    rejectReason: { type: String, maxlength: 500 },
    activatedAt: { type: Date },
    endsAt: { type: Date, default: null },
    endedAt: { type: Date },
    endedBy: { type: String, enum: [...contractSides, "expiry"] },
    endReason: { type: String, maxlength: 500 },
    applied: { type: Boolean, default: false },
  },
  { timestamps: true },
);

InsuranceContractSchema.index(
  { insurance: 1, providerKind: 1, provider: 1 },
  { unique: true, partialFilterExpression: { open: true } },
);
InsuranceContractSchema.index({ providerKind: 1, provider: 1, status: 1 });
InsuranceContractSchema.index({ insurance: 1, status: 1 });
InsuranceContractSchema.index({ status: 1, applied: 1 });

const InsuranceContract = mongoose.model("InsuranceContract", InsuranceContractSchema);

export default InsuranceContract;
