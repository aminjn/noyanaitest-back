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
  },
  {
    name: "blogcategory",
    model: BlogCategory,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
  },
  {
    name: "inlinead",
    model: InlineAdvertisement,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
  },
  {
    name: "blogmedia",
    model: BlogMedia,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
  },
  { name: "textcontent", model: TextContent, singleton: true, edit: true },
  {
    name: "speciality",
    model: Speciality,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
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
  },
  { name: "user", all: true, one: true, edit: true, model: User },
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
    ]),
  },
];

for (let i = 0; i < map.length; i++) {
  const segment = map[i];
  if (segment.singleton) {
    router
      .route(`/${segment.name}`)
      .get(
        authController.protect,
        authController.restrictTo("admin"),
        autoController.getSingleton({ model: segment.model })
      );
    if (segment.edit)
      router
        .route(`/${segment.name}`)
        .post(
          authController.protect,
          authController.restrictTo("admin"),
          uploadController.upload.any(),
          uploadController.saveUplaodsToBody({ name: segment.name }),
          autoController.editSingleton({ model: segment.model })
        );
  } else {
    if (segment.all)
      router.route(`/${segment.name}`).get(
        authController.protect,
        authController.restrictTo("admin"),
        autoController.getAll({
          model: segment.model,
          population: segment.allPopulation,
          selection: segment.allSelection,
        })
      );
    if (segment.create)
      router
        .route(`/${segment.name}`)
        .post(
          authController.protect,
          authController.restrictTo("admin"),
          uploadController.upload.any(),
          uploadController.saveUplaodsToBody({ name: segment.name }),
          autoController.create({ model: segment.model })
        );
    if (segment.one)
      router.route(`/${segment.name}/:nodeId`).get(
        authController.protect,
        authController.restrictTo("admin"),
        autoController.getOne({
          model: segment.model,
          pop: segment.onePopulation,
        })
      );
    if (segment.edit)
      router
        .route(`/${segment.name}/:nodeId`)
        .post(
          authController.protect,
          authController.restrictTo("admin"),
          uploadController.upload.any(),
          uploadController.saveUplaodsToBody({ name: segment.name }),
          ...(segment.editBodyMutator ? [segment.editBodyMutator] : []),
          autoController.edit({ model: segment.model })
        );
    if (segment.remove)
      router
        .route(`/${segment.name}/:nodeId`)
        .put(
          authController.protect,
          authController.restrictTo("admin"),
          autoController.remove({ model: segment.model })
        );
  }
}

export default router;
