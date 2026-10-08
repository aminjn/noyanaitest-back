import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IPendingUser } from "./PendingUser";
import { TooManyTrysError as TooManyAttemptsError } from "../Lib/AppError";
import { clamp } from "../Lib/helpers";
import * as env from "../Lib/Env";

export interface IToken extends MongoDoc {
  owner: IUser | IPendingUser;
  code?: string;
  initiatedAt?: Date;
  lastSent?: Date;
  sendCount: number;
  tried: number;
  isExpired: () => boolean;
  canSendAgain: () => Promise<boolean>;
  refreshToken: () => Promise<string>;
  isCorrectCode: (code: string) => Promise<boolean>;
  canSendAgainAt: () => Date;
}

const tokenSchema = new mongoose.Schema<IToken, Model<IToken>>({
  owner: {
    type: mongoose.Schema.ObjectId,
    refPath: "model",
    required: true,
    unique: true,
  },
  code: { type: String },
  initiatedAt: { type: Date },
  lastSent: { type: Date },
  sendCount: { type: Number, default: 0 },
  tried: { type: Number, default: 0 },
});

tokenSchema.pre("save", function (next) {
  // a new code starts its own lifetime and its own tries; clearing the
  // code (a failed send) leaves nothing running
  if (this.isModified("code")) {
    this.initiatedAt = this.code ? new Date() : undefined;
    this.tried = 0;
  }
  next();
});

tokenSchema.method("isExpired", function (): boolean {
  if (this.initiatedAt) {
    const then = new Date(this.initiatedAt);
    then.setSeconds(then.getSeconds() + env.OTP_TTL);
    if (then > new Date()) return false;
  }
  return true;
});

tokenSchema.method("canSendAgain", async function (): Promise<boolean> {
  if (this.lastSent || this.initiatedAt) {
    const then = new Date(this.lastSent || this.initiatedAt || new Date());
    then.setSeconds(
      then.getSeconds() +
        env.BASE_OTP_INTERVAL * Math.pow(2, clamp(0, this.sendCount, 8))
    );
    if (then < new Date()) {
      this.$inc("sendCount", 1);
      this.lastSent = new Date();
      await this.save();
      return true;
    }
    return false;
  } else {
    this.$inc("sendCount", 1);
    this.lastSent = new Date();
    await this.save();
    return true;
  }
});

tokenSchema.method("canSendAgainAt", function () {
  const then = new Date(this.lastSent || this.initiatedAt || new Date());
  then.setSeconds(
    then.getSeconds() + env.BASE_OTP_INTERVAL * Math.pow(2, this.sendCount)
  );
  return then;
});

tokenSchema.method(
  "isCorrectCode",
  async function (code: string): Promise<boolean> {
    if (this.tried > env.OTP_MAX_TRYS) throw new TooManyAttemptsError();
    if (this.code === code) {
      this.code = undefined;
      this.sendCount = 0;
      await this.save();
      return true;
    } else {
      this.$inc("tried", 1);
      await this.save();
      return false;
    }
  }
);

const Token = mongoose.model("Token", tokenSchema);

export default Token;
