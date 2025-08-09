import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface Singleton extends MongoDoc {
  singleton: "SINGLETON";
}

const contentKeys = [
  "homePage",
  "officeBook",
  "medicalConsult",
  "phoneConsult",
  "textConsult",
  "aiDetection",
  "blog",
  "forDoctors",
  "login",
  "male",
  "female",
  "medicalSystemTitle",
  "medicalSystemCode",
  "specialities",
  "province",
  "city",
  "address",
  "description",
  "online",
  "dashboard",
  "financialMangement",
  "toman",
  "secrataries",
  "bookingCalendar",
  "patients",
  "licenses",
  "clinics",
  "phrmaciesAndLabs",
  "insurances",
  "offers",
  "discounts",
  "articles",
  "chatWithPatients",
  "drugsAndPrescriptions",
  "patientDocuments",
  "logout",
  "buyLicense",
  "currentLicense",
  "deposit",
  "currentBalance",
  "doctorClinics",
  "doctorJoinClinics",
  "clinicAdditionRequests",
  "clinicsList",
  "clinicName",
  "department",
  "noDepartment",
  "actions",
  "newItem",
  "joinClinicRequest",
  "nothingFound",
  "clickToRequestAddClinic",
  "message",
  "submitRequest",
  "loading",
  "checkInput",
  "submittedAt",
  "submissionParty",
  "doctor",
  "clinic",
  "status",
  "Pending",
  "Approved",
  "Rejected",
  "statusLastChangedAt",
  "resubmitJoinClinicRequestConfirmationMessage",
  "leaveClinicConfirmationMessage",
  "clinicAddress",
  "ownerPhone",
  "Proccessing",
  "Done",
  "ownerName",
  "cancel",
  "submit",
] as const;

type ContentKey = (typeof contentKeys)[number];

export type ITextContent = Singleton & {
  [key in ContentKey]: string;
};

const TextContentSchema = new mongoose.Schema<
  ITextContent,
  Model<ITextContent>
>({
  singleton: {
    type: String,
    required: true,
    immutable: true,
    unique: true,
    trim: true,
    enum: ["SINGLETON"],
    default: "SINGLETON",
  },
  ...contentKeys.reduce(
    (acc, key) => ({ ...acc, [key]: { type: String, default: key } }),
    {}
  ),
});

const TextContent = mongoose.model("TextContent", TextContentSchema);

export default TextContent;
