import express, { RequestHandler } from "express";
import { Model, PopulateOptions } from "mongoose";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";
import Blog from "../Models/Blog";
import BlogCategory from "../Models/BlogCategory";
import InlineAdvertisement from "../Models/InlineAdvertisement";
import BlogMedia from "../Models/BlogMedia";
import TextContent from "../Models/TextContent";
import Speciality from "../Models/Speciality";
import BecomeDoctorRequest from "../Models/BecomeDoctorRequest";
import User from "../Models/User";
import DoctorProfile from "../Models/DoctorProfile";
import Doctor from "../Models/Doctor";
import GalleryItem from "../Models/GalleryItem";
import AccessLevel, { AccessLevelModel } from "../Models/AccessLevel";
import UserAccessLevel from "../Models/UserAccessLevel";
import Clinic from "../Models/Clinic";
import ClinicDepartment from "../Models/ClinicDepatment";
import ClinicDoctor from "../Models/ClinicDoctor";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import Insurance from "../Models/Insurance";
import Pharmacy from "../Models/Pharmacy";
import BecomeClinicRequest from "../Models/BecomeClinicRequest";
import BecomeInsuranceRequest from "../Models/BecomeInsuranceRequest";
import BecomePharmacyRequest from "../Models/BecomePharmacyRequest";
import CallRoom from "../Models/CallRoom";
import Redirection from "../Models/Redirection";
import ShortLink from "../Models/ShortLink";
import Disease from "../Models/Disease";
import Drug from "../Models/Drug";
import Symptom from "../Models/Symptom";
import Part from "../Models/Part";
import DoctorFaq from "../Models/DoctorFaq";
import TaminServiceType from "../Models/TaminServiceType";
import TaminPrescriptionType from "../Models/TaminPrescriptionType";
import TaminService from "../Models/TaminService";
import TaminParTaref from "../Models/TaminParTaref";
import TaminDrugUsage from "../Models/TaminDrugUsage";
import TaminDrugInstruction from "../Models/TaminDrugInstruction";
import TaminDrugAmount from "../Models/TaminDrugAmount";

const router = express.Router();

const map: {
  name: string;
  model: Model<any>;
  one?: boolean;
  all?: boolean;
  create?: boolean;
  remove?: boolean;
  edit?: boolean;
  singleton?: boolean;
  allPopulation?: PopulateOptions | PopulateOptions[];
  allSelection?: Record<string, number | boolean | string | object>;
  onePopulation?: PopulateOptions | PopulateOptions[];
  editBodyMutator?: RequestHandler;
  accessLevel?: AccessLevelModel;
}[] = [
  {
    name: "blog",
    model: Blog,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allSelection: { content: false },
    allPopulation: [
      { path: "related", select: ["title", "_id"] },
      { path: "category" },
    ],
    editBodyMutator: autoController.mutateCompoundFields(["related"]),
    accessLevel: "Blog",
  },
  {
    name: "blogcategory",
    model: BlogCategory,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    accessLevel: "BlogCategory",
  },
  {
    name: "inlinead",
    model: InlineAdvertisement,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "InlineAdvertisement",
  },
  {
    name: "blogmedia",
    model: BlogMedia,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    accessLevel: "BlogMedia",
  },
  {
    name: "textcontent",
    model: TextContent,
    singleton: true,
    edit: true,
    accessLevel: "TextContent",
  },
  {
    name: "speciality",
    model: Speciality,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    accessLevel: "Sepciality",
  },
  {
    name: "becomedoctor",
    model: BecomeDoctorRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }, { path: "specialities" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeDoctorRequest",
  },
  {
    name: "becomeclinic",
    model: BecomeClinicRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeClinicRequest",
  },
  {
    name: "becomeinsurance",
    model: BecomeInsuranceRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeInsuranceRequest",
  },
  {
    name: "becomepharmacy",
    model: BecomePharmacyRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomePharmacyRequest",
  },
  {
    name: "user",
    all: true,
    one: true,
    edit: true,
    model: User,
    accessLevel: "User",
  },
  {
    name: "doctorprofile",
    model: DoctorProfile,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    allPopulation: [
      { path: "phoneConsultSettings" },
      { path: "user" },
      { path: "mainSpeciality" },
    ],
    onePopulation: [{ path: "phoneConsultSettings" }],
    editBodyMutator: autoController.mutateCompoundFields([
      "services",
      "achivements",
      "specialities",
      "location",
    ]),
    accessLevel: "DoctorProfile",
  },
  {
    name: "doctor",
    model: Doctor,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    allPopulation: [{ path: "speciality" }],
    accessLevel: "Doctor",
  },
  {
    name: "galleryitem",
    model: GalleryItem,
    all: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "GalleryItem",
  },
  {
    name: "accesslevel",
    model: AccessLevel,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    onePopulation: { path: "admins", populate: { path: "user" } },
    editBodyMutator: autoController.mutateCompoundFields(["$set"]),
  },
  {
    name: "useraccesslevel",
    model: UserAccessLevel,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    allPopulation: [{ path: "user" }, { path: "accessLevel" }],
  },
  {
    name: "clinic",
    model: Clinic,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "Clinic",
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
  },
  {
    name: "clinicdepartment",
    model: ClinicDepartment,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "ClinicDepartment",
    allPopulation: { path: "doctorsCount" },
  },
  {
    name: "clinicdoctor",
    model: ClinicDoctor,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "ClinicDoctor",
    allPopulation: [{ path: "doctor" }, { path: "department" }],
  },
  {
    name: "doctorjoinclinic",
    model: DoctorJoinClinicRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    accessLevel: "DoctorJoinClinic",
    allPopulation: [{ path: "doctor" }, { path: "clinic" }],
  },
  {
    name: "clinicaddition",
    model: ClinicAdditionRequest,
    accessLevel: "ClinicAdditionRequest",
    all: true,
    one: true,
    edit: true,
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: { path: "submittedBy" },
  },
  {
    name: "insurance",
    model: Insurance,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "Insurance",
  },
  {
    name: "pharmacy",
    model: Pharmacy,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "Pharmacy",
  },
  {
    name: "callroom",
    model: CallRoom,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "CallRoom",
    allPopulation: { path: "participants" },
    editBodyMutator: autoController.mutateCompoundFields(["participants"]),
  },
  {
    name: "redirection",
    model: Redirection,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "Redirection",
  },
  {
    name: "shortlink",
    model: ShortLink,
    accessLevel: "ShortLink",
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
  },
  {
    name: "disease",
    model: Disease,
    accessLevel: "Disease",
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    onePopulation: [
      { path: "drugs" },
      { path: "sameAs" },
      { path: "specialities" },
      { path: "symptoms" },
    ],
    editBodyMutator: autoController.mutateCompoundFields([
      "symptoms",
      "specialities",
      "drugs",
      "sameAs",
    ]),
  },
  {
    name: "drug",
    model: Drug,
    accessLevel: "Drug",
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
  },
  {
    name: "symptom",
    model: Symptom,
    accessLevel: "Symptom",
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "part" }, { path: "sameAs" }],
    editBodyMutator: autoController.mutateCompoundFields(["part", "sameAs"]),
  },
  {
    name: "part",
    model: Part,
    accessLevel: "Part",
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "doctorfaq",
    model: DoctorFaq,
    accessLevel: "DoctorFaq",
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
    allPopulation: [{ path: "doctor" }],
  },
  { name: "taminServiceType", model: TaminServiceType, all: true, edit: true },
  {
    name: "taminPrescriptionType",
    model: TaminPrescriptionType,
    all: true,
    edit: true,
  },
  { name: "taminService", model: TaminService, all: true, edit: true },
  { name: "taminParTaref", model: TaminParTaref, all: true, edit: true },
  { name: "taminDrugUsage", model: TaminDrugUsage, all: true, edit: true },
  {
    name: "taminDrugInstruction",
    model: TaminDrugInstruction,
    all: true,
    edit: true,
  },
  { name: "taminDrugAmount", model: TaminDrugAmount, all: true, edit: true },
];

const withAccessLevelRoles = ["admin", "notadmin"] as const;
const noAccessLevelRoles = ["admin"] as const;

for (let i = 0; i < map.length; i++) {
  const segment = map[i];
  if (segment.singleton) {
    router.route(`/${segment.name}`).get(
      authController.protect,
      authController.restrictTo(
        ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles)
      ),
      ...(segment.accessLevel
        ? [
            authController.hasPermission({
              model: segment.accessLevel,
              op: "readOne",
            }),
          ]
        : []),
      autoController.getSingleton({ model: segment.model })
    );
    if (segment.edit)
      router.route(`/${segment.name}`).post(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles)
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "update",
              }),
            ]
          : []),
        uploadController.upload.any(),
        uploadController.saveUplaodsToBody({ name: segment.name }),
        autoController.editSingleton({ model: segment.model })
      );
  } else {
    if (segment.all)
      router.route(`/${segment.name}`).get(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles)
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "readAll",
              }),
            ]
          : []),
        autoController.getAll({
          model: segment.model,
          population: segment.allPopulation,
          selection: segment.allSelection,
        })
      );
    if (segment.create)
      router.route(`/${segment.name}`).post(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles)
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "write",
              }),
            ]
          : []),
        uploadController.upload.any(),
        uploadController.saveUplaodsToBody({ name: segment.name }),
        ...(segment.editBodyMutator ? [segment.editBodyMutator] : []),
        autoController.create({ model: segment.model })
      );
    if (segment.one)
      router.route(`/${segment.name}/:nodeId`).get(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles)
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "readOne",
              }),
            ]
          : []),
        autoController.getOne({
          model: segment.model,
          pop: segment.onePopulation,
        })
      );
    if (segment.edit)
      router.route(`/${segment.name}/:nodeId`).post(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles)
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "update",
              }),
            ]
          : []),
        uploadController.upload.any(),
        uploadController.saveUplaodsToBody({ name: segment.name }),
        ...(segment.editBodyMutator ? [segment.editBodyMutator] : []),
        autoController.edit({ model: segment.model })
      );
    if (segment.remove)
      router.route(`/${segment.name}/:nodeId`).put(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles)
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "delete",
              }),
            ]
          : []),
        autoController.remove({ model: segment.model })
      );
  }
}

export default router;
