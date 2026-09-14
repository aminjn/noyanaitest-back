import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Singleton document caching the Tapsi Corporate API's JWT access token
// (2026-09) - see Lib/tapsiClient.ts. Mirrors Models/SnappCredential.ts's
// singleton pattern. Kept in the DB rather than in memory so the token
// survives a server restart (avoids re-logging in on every boot) and is
// shared across all app instances/workers. Unlike Snapp, Tapsi's login
// response has no refresh token - the only documented way to get a fresh
// one is calling login again (see Lib/tapsiClient.ts's request()'s
// retry-once-on-401 behavior).
export interface ITapsiCredential extends MongoDoc {
  singleton: "SINGLETON";

  token?: string;
  // when `token` was last obtained (login call). Tokens expire after 1
  // hour (3600s) per the docs - not enforced client-side, the client just
  // re-logs-in and retries once on a 401.
  updatedAt?: Date;
}

const TapsiCredentialSchema = new mongoose.Schema<
  ITapsiCredential,
  Model<ITapsiCredential>
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
  updatedAt: { type: Date },
});

const TapsiCredential = mongoose.model(
  "TapsiCredential",
  TapsiCredentialSchema,
);

export default TapsiCredential;
