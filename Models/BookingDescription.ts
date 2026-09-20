import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Which org-type booking flow this description applies to. Extend this list
// alongside any new bookable org type.
export const bookingDescriptionSegments = ["Doctor", "Clinic", "Pharmacy"] as const;

export type BookingDescriptionSegment =
  (typeof bookingDescriptionSegments)[number];

export interface IBookingDescription extends MongoDoc {
  title: string;
  description: string;
  isActive: boolean;
  order: number;
  segment: BookingDescriptionSegment;
}

const BookingDescriptionSchema = new mongoose.Schema<
  IBookingDescription,
  Model<IBookingDescription>
>({
  title: { type: String, required: true },
  description: { type: String, required: true },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  segment: {
    type: String,
    enum: bookingDescriptionSegments,
    required: true,
  },
});

const BookingDescription = mongoose.model(
  "BookingDescription",
  BookingDescriptionSchema,
);

export default BookingDescription;
