import { translatable } from "../../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";

export type IPosition = [longitude: number, latitude: number];
export type ILinearRing = IPosition[];

export interface IPolygon {
  type: "Polygon";
  coordinates: ILinearRing[];
}

const _PolygonSchema = new mongoose.Schema<IPolygon, Model<IPolygon>>(
  {
    type: {
      type: String,
      enum: ["Polygon"],
      required: true,
      default: "Polygon",
    },
    coordinates: {
      type: [[[Number]]],
      required: true,
      default: [],
      validate: {
        validator(rings: number[][][]) {
          return rings.every((ring) => {
            if (ring.length < 4) return false;

            const first = ring[0];
            const last = ring[ring.length - 1];

            return (
              first.length === 2 &&
              last.length === 2 &&
              first[0] === last[0] &&
              first[1] === last[1]
            );
          });
        },
        message: "Polygon rings must be closed",
      },
    },
  },
  { _id: false },
);

export const PolygonSchema = _PolygonSchema;

export interface IProvince extends MongoDoc {
  name?: string;
  order: number;
  isActive: boolean;
  geometry: IPolygon;
  slug?: string;
  // NexaMap's (OSM) id of this division, set by the admin divisions sync
  // and used to map a point (Lib/geoFromPoint.ts) to our record
  nexamapId?: string;
}

const ProvinceSchema = new mongoose.Schema<IProvince, Model<IProvince>>(
  {
    name: { type: String },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false },
    geometry: PolygonSchema,
    slug: { type: String, unique: true, sparse: true },
    nexamapId: { type: String, index: true, sparse: true },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

ProvinceSchema.index({ geometry: "2dsphere" });

ProvinceSchema.virtual("cities", {
  ref: "City",
  foreignField: "province",
  localField: "_id",
});

ProvinceSchema.plugin(translatable);

const Province = mongoose.model("Province", ProvinceSchema);

export default Province;
