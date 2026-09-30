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
  updatedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  updatedAt: { type: Date },
});

const SmsGatewaySettings = mongoose.model(
  "SmsGatewaySettings",
  SmsGatewaySettingsSchema,
);

export default SmsGatewaySettings;
