import { translatable } from "../../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";
import { ICity } from "./City";
import { IPolygon, PolygonSchema } from "./Province";

export interface IDistrict extends MongoDoc {
  name?: string;
  order: number;
  isActive?: boolean;
  city: ICity;
  geometry: IPolygon;
}

const DistrictSchema = new mongoose.Schema<IDistrict, Model<IDistrict>>(
  {
    name: { type: String },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false },
    city: { type: mongoose.Schema.ObjectId, ref: "City", required: true },
    geometry: PolygonSchema,
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

DistrictSchema.index({ geometry: "2dsphere" });

DistrictSchema.plugin(translatable);

const District = mongoose.model("District", DistrictSchema);

export default District;
