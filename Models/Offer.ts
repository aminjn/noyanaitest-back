import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IProduct } from "./Product";
import { IService } from "./Service";
import { IInvoice } from "./Invoice";
import { IComment } from "./Comment";

const offerOwners = [
  "DoctorProfile",
  "Pharmacy",
  "Laboratory",
  "Insurance",
] as const;

type OfferOwner = (typeof offerOwners)[number];

const offerStatuses = ["Draft", "Pending", "Active", "Archive"] as const;

type OfferStatus = (typeof offerStatuses)[number];

export interface IOffer extends MongoDoc {
  user: IUser;
  owner: mongoose.Types.ObjectId;
  ownerPath: OfferOwner;
  title?: string;
  description?: string;
  banner?: string;
  initiatedAt: Date;
  startsAt?: Date;
  endsAt?: Date;
  publishTime?: Date;
  products: { item: IProduct; qty: number; description?: string }[];
  services: { item: IService; qty: string; description?: string }[];
  discountAmount?: number;
  netPriceAfterDiscount?: number;
  limit?: number;
  status: OfferStatus;
  published?: boolean;
  active: boolean;
  order?: number;
  bold?: boolean;

  //virtuals
  sales?: IInvoice[];
  remainigAmount: number;
  totalSalesAmount?: number;
  uniqueCustomers?: IUser[];
  favoritedBy?: IUser[];
  comments?: IComment[];
  score?: number;
}

const OfferSchema = new mongoose.Schema<IOffer, Model<IOffer>>({});

const Offer = mongoose.model("Offer", OfferSchema);

export default Offer;
