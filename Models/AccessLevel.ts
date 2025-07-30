import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export const accessOperations = [
  "readAll",
  "readOne",
  "write",
  "update",
  "delete",
] as const;

export type AccessOperation = (typeof accessOperations)[number];

type Access = { [key in AccessOperation]?: boolean };

export const accessLevelModels = [
  "BecomeDoctorRequest",
  "Blog",
  "BlogCategory",
  "BlogMedia",
  "Comment",
  "Doctor",
  "DoctorProfile",
  "GalleryItem",
  "InlineAdvertisement",
  "Sepciality",
  "TextContent",
  "User",
] as const;

export type AccessLevelModel = (typeof accessLevelModels)[number];

export type IAccessLevel = MongoDoc & {
  name: string;
} & { [key in AccessLevelModel]?: Access };

const AccessSchema = new mongoose.Schema<Access, Model<Access>>(
  accessOperations.reduce(
    (acc, op) => ({ ...acc, [op]: { type: Boolean, default: false } }),
    {}
  ),
  { _id: false }
);

const AccessLevelSchema = new mongoose.Schema<
  IAccessLevel,
  Model<IAccessLevel>
>(
  {
    name: { type: String },
    ...accessLevelModels.reduce(
      (acc, model) => ({
        ...acc,
        [model]: {
          type: AccessSchema,
          default: () => ({}),
        },
      }),
      {}
    ),
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

AccessLevelSchema.virtual("admins", {
  ref: "UserAccessLevel",
  localField: "_id",
  foreignField: "accessLevel",
});

const AccessLevel = mongoose.model("AccessLevel", AccessLevelSchema);

export default AccessLevel;
