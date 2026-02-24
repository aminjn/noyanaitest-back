import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { ITaminService } from "./TaminService";

export interface IFavoriteLabItem extends MongoDoc {
  doctor: IDoctorProfile;
  item: ITaminService;
  description?: string;
}

const FavoriteLabItemSchema = new mongoose.Schema<
  IFavoriteLabItem,
  Model<IFavoriteLabItem>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  item: { type: mongoose.Schema.ObjectId, ref: "TaminService", required: true },
  description: { type: String },
});

const FavoriteLabItem = mongoose.model(
  "FavoriteLabItem",
  FavoriteLabItemSchema,
);

export default FavoriteLabItem;
