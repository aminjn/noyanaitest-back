import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IAboutTeam extends MongoDoc {
  avatar?: string;
  name?: string;
  title?: string;
  description?: string;
  linkedin?: string;
  isActive: boolean;
  order: number;
}

const AboutTeamSchema = new mongoose.Schema<IAboutTeam, Model<IAboutTeam>>({
  avatar: { type: String },
  name: { type: String },
  title: { type: String },
  description: { type: String },
  linkedin: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

AboutTeamSchema.plugin(translatable);

const AboutTeam = mongoose.model("AboutTeam", AboutTeamSchema);

export default AboutTeam;
