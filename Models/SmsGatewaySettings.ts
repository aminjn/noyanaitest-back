import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// SMS gateway credentials (IPPanel, pattern send), set from the super admin
// panel (/notadmin/smsSettings) instead of only the server's .env. The .env
// values (SMS_API_TOKEN / SMS_FROM_NUMBER / SMS_REQUEST_URL) stay as the
// fallback, so an existing deployment keeps working unchanged. The token is
// never sent back to the browser (select: false; the admin sees only its
// last 4 characters).
export interface ISmsGatewaySettings extends MongoDoc {
  singleton: "SINGLETON";
  apiToken?: string;
  fromNumber?: string;
  requestUrl?: string;
  // the advertising line campaign SMS go out from (2026-10, Lib/business/
  // campaign.ts): operators carry promotional text only on such a line,
  // never on the service line the patterns use
  marketingFromNumber?: string;
  // advertising SMS rules (Lib/smsPolicy.ts): the Tehran hours they may
  // leave in [from, until) - the rest of the day is quiet - and the most
  // one provider may send in a Tehran day (0 = no cap)
  campaignWindowFrom?: number;
  campaignWindowUntil?: number;
  campaignDailyCap?: number;
  updatedBy?: mongoose.Types.ObjectId;
  updatedAt?: Date;
}

const SmsGatewaySettingsSchema = new mongoose.Schema<
  ISmsGatewaySettings,
  Model<ISmsGatewaySettings>
>({
  singleton: { type: String, enum: ["SINGLETON"], default: "SINGLETON", unique: true },
  apiToken: { type: String, trim: true, select: false },
  fromNumber: { type: String, trim: true },
  requestUrl: { type: String, trim: true },
  marketingFromNumber: { type: String, trim: true },
  campaignWindowFrom: { type: Number, min: 0, max: 23, default: 8 },
  campaignWindowUntil: { type: Number, min: 1, max: 24, default: 21 },
  campaignDailyCap: { type: Number, min: 0, max: 1_000_000, default: 0 },
  updatedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  updatedAt: { type: Date },
});

const SmsGatewaySettings = mongoose.model(
  "SmsGatewaySettings",
  SmsGatewaySettingsSchema,
);

export default SmsGatewaySettings;
