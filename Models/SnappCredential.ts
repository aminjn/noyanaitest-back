import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Singleton document caching the Snapp corporate API's access/refresh token
// pair (2026-09) - see Lib/snappClient.ts. Mirrors Models/AppConfig.ts's /
// Models/GlobalFinanceSettings.ts's singleton pattern. Kept in the DB rather
// than in memory so the token survives a server restart (avoids re-logging
// in on every boot) and is shared across all app instances/workers.
export interface ISnappCredential extends MongoDoc {
  singleton: "SINGLETON";

  token?: string;
  refreshToken?: string;
  // when `token` was last obtained/renewed (login or refresh-token call)
  updatedAt?: Date;
}

const SnappCredentialSchema = new mongoose.Schema<
  ISnappCredential,
  Model<ISnappCredential>
>({
  singleton: {
    type: String,
    required: true,
    default: "SINGLETON",
    enum: ["SINGLETON"],
    immutable: true,
    unique: true,
  },
  token: { type: String, select: false },
  refreshToken: { type: String, select: false },
  updatedAt: { type: Date },
});

const SnappCredential = mongoose.model(
  "SnappCredential",
  SnappCredentialSchema,
);

export default SnappCredential;
