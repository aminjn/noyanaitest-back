import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export const socialMedias = [
  "Instagram",
  "Telegarm",
  "Whatsapp",
  "Aparat",
] as const;

export type SocialMedia = (typeof socialMedias)[number];

export interface IDoctorSocialMedia extends MongoDoc {
  doctor: IDoctorProfile;
  target: string;
  media: SocialMedia;
}

const DoctorSocialMediaSchema = new mongoose.Schema<
  IDoctorSocialMedia,
  Model<IDoctorSocialMedia>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  target: { type: String, required: true },
  media: { type: String, required: true, enum: socialMedias },
});

const DoctorSocialMedia = mongoose.model(
  "DoctorSocialMedia",
  DoctorSocialMediaSchema
);

export default DoctorSocialMedia;
