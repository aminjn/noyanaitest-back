import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

const galleryItemOwnerPaths = ["Doctor", "DoctorProfile"] as const;

type GalleryItemOwnerPath = (typeof galleryItemOwnerPaths)[number];

export interface IGalleryItem extends MongoDoc {
  owner: mongoose.Types.ObjectId;
  ownerPath: GalleryItemOwnerPath;
  image?: string;
  alt?: string;
  description?: string;
  createdAt: Date;
  order: number;
  active: boolean;
}

const GalleryItemSchema = new mongoose.Schema<
  IGalleryItem,
  Model<IGalleryItem>
>({
  owner: {
    type: mongoose.Schema.ObjectId,
    refPath: "ownerPath",
    required: true,
  },
  ownerPath: { type: String, enum: galleryItemOwnerPaths, required: true },
  image: { type: String, required: true },
  alt: { type: String, required: true },
  description: { type: String },
  createdAt: { type: Date, default: () => new Date() },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: false },
});

GalleryItemSchema.plugin(translatable);

const GalleryItem = mongoose.model("GalleryItem", GalleryItemSchema);

export default GalleryItem;
