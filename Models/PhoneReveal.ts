import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// One "show phone number" click on a public profile (2026-10). The page no
// longer carries the number: the visitor asks for it (Paziresh24 / Doctoreto
// «نمایش شماره»), the backend answers from POST /public/phone/:kind/:id and
// writes one of these. It is what the super admin's report (analytics ->
// «نمایش شماره تماس») and the provider's dashboard card count.
// Append-only: nothing edits or deletes a reveal.
export const phoneRevealKinds = ["doctor", "clinic", "hospital", "pharmacy", "paraClinic"] as const;
export type PhoneRevealKind = (typeof phoneRevealKinds)[number];

export const phoneRevealDevices = ["mobile", "tablet", "desktop"] as const;
export type PhoneRevealDevice = (typeof phoneRevealDevices)[number];

export interface IPhoneReveal extends MongoDoc {
  kind: PhoneRevealKind;
  // the profile whose number was shown (a DoctorProfile, Clinic, ...)
  target: mongoose.Types.ObjectId;
  // the anonymous visitor-id cookie (Models/VisitorIdentity.ts)
  visitor?: string;
  // the account, when the visitor was logged in
  user?: mongoose.Types.ObjectId;
  // a keyed hash of the IP (rate limits and "unique" counts, never the IP)
  ipHash?: string;
  // the page the click came from (path only) and where on it
  source?: string;
  placement?: string;
  device: PhoneRevealDevice;
  createdAt: Date;
}

const PhoneRevealSchema = new mongoose.Schema<IPhoneReveal, Model<IPhoneReveal>>(
  {
    kind: { type: String, enum: phoneRevealKinds, required: true, immutable: true },
    target: { type: mongoose.Schema.ObjectId, required: true, immutable: true },
    visitor: { type: String, immutable: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User", immutable: true },
    ipHash: { type: String, immutable: true },
    source: { type: String, maxlength: 300, immutable: true },
    placement: { type: String, maxlength: 40, immutable: true },
    device: { type: String, enum: phoneRevealDevices, default: "desktop", immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// a provider's counts (one target, a time range) and the admin's report
PhoneRevealSchema.index({ kind: 1, target: 1, createdAt: -1 });
PhoneRevealSchema.index({ createdAt: -1 });

const PhoneReveal = mongoose.model("PhoneReveal", PhoneRevealSchema);

export default PhoneReveal;
