import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// One wallet per clinic / hospital (2026-10, owner decision). One account
// can own several centres (Lib/activeCentre.ts); each centre's money - what
// it earns, what it spends on its plan and its SMS, what it withdraws to its
// own Sheba, what the support team corrects - lives here, apart from the
// owner's personal (buyer) wallet in Models/Wallet.ts and apart from the
// owner's other centres. The wallet belongs to the centre, not the person:
// when a centre changes hands its money goes with it. Doctolib and Practo
// settle each practice / site on its own account the same way. Doctors,
// pharmacies, labs and insurers stay one per account, on the personal
// wallet. Lib/walletScope.ts is the only place that reads or moves it.
export const centreWalletKinds = ["clinic", "hospital"] as const;
export type CentreWalletKind = (typeof centreWalletKinds)[number];

export interface ICentreWallet extends MongoDoc {
  kind: CentreWalletKind;
  centre: mongoose.Types.ObjectId;
  balance: number;
  // earnings still in their settlement hold (Lib/payoutHold.ts)
  pending: number;
}

const CentreWalletSchema = new mongoose.Schema<ICentreWallet, Model<ICentreWallet>>({
  kind: { type: String, enum: centreWalletKinds, required: true },
  centre: { type: mongoose.Schema.ObjectId, required: true },
  balance: { type: Number, default: 0, min: 0 },
  pending: { type: Number, default: 0, min: 0 },
});

CentreWalletSchema.index({ kind: 1, centre: 1 }, { unique: true });

const CentreWallet = mongoose.model("CentreWallet", CentreWalletSchema);

export default CentreWallet;
