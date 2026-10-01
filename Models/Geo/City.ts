import { translatable } from "../../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { IPolygon, IProvince, PolygonSchema } from "./Province";
import { MongoDoc } from "../User";

export interface ICity extends MongoDoc {
  name?: string;
  order: number;
  isActive: boolean;
  province: IProvince;
  geometry: IPolygon;
  // NexaMap's (OSM) id of this division, set by the admin divisions sync
  // and used to map a point (Lib/geoFromPoint.ts) to our record
  nexamapId?: string;
}

const CitySchema = new mongoose.Schema<ICity, Model<ICity>>(
  {
    name: { type: String },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false },
    province: {
      type: mongoose.Schema.ObjectId,
      ref: "Province",
      required: true,
    },
    geometry: PolygonSchema,
    nexamapId: { type: String, index: true, sparse: true },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

CitySchema.index({ geometry: "2dsphere" });

CitySchema.virtual("districts", {
  ref: "District",
  localField: "_id",
  foreignField: "city",
});

CitySchema.plugin(translatable);

const City = mongoose.model("City", CitySchema);

export default City;
