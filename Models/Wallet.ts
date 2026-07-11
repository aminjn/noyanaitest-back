import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export interface IWallet extends MongoDoc {
  user: IUser;
  balance: number;
}

const WalletSchema = new mongoose.Schema<IWallet, Model<IWallet>>({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  balance: { type: Number, default: 0, min: 0 },
});

const Wallet = mongoose.model("Wallet", WalletSchema);

export default Wallet;
