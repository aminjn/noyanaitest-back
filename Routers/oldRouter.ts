import express, { Request, RequestHandler, Response } from "express";
import { Model, PopulateOptions } from "mongoose";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";
import OldDoctor from "../Models/Old/oldDoctor";
import OldUser from "../Models/Old/oldUser";
import OldSpeciality from "../Models/Old/oldSpeciality";
import OldBlog from "../Models/Old/OldBlog";
import OldDisease from "../Models/Old/OldDisease";
import OldDrug from "../Models/Old/OldDrug";
import OldPart from "../Models/Old/OldPart";
import OldSymptom from "../Models/Old/OldSymptom";
import DoctorProfile from "../Models/DoctorProfile";
import catchAsync from "../Lib/catchAsync";

const router = express.Router();

// old doctor -> the bookable profile it was merged into (Lib/mergeLegacyDoctors),
// so the old list links each row to the record the admin actually edits
router.get(
  "/doctor/profiles",
  authController.protect,
  authController.restrictTo("admin"),
  catchAsync(async (_req: Request, res: Response) => {
    const rows = await DoctorProfile.find({ legacyDoctor: { $ne: null } })
      .select("legacyDoctor firstName lastName")
      .lean<{ _id: unknown; legacyDoctor: unknown; firstName?: string; lastName?: string }[]>();
    res.status(200).json({
      message: "oldDoctorProfiles",
      data: {
        data: Object.fromEntries(
          rows.map((r) => [String(r.legacyDoctor), { _id: String(r._id), name: [r.firstName, r.lastName].filter(Boolean).join(" ") }]),
        ),
      },
    });
  }),
);

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
    name: "doctor",
    model: OldDoctor,
    all: true,
    allPopulation: [
      { path: "user", model: OldUser },
      { path: "speciality", model: OldSpeciality },
    ],
  },
  { name: "user", model: OldUser, all: true },
  { name: "speciality", model: OldSpeciality, all: true },
  { name: "blog", model: OldBlog, all: true },
  { name: "disease", model: OldDisease, all: true },
  { name: "drug", model: OldDrug, all: true },
  { name: "part", model: OldPart, all: true },
  { name: "symptom", model: OldSymptom, all: true },
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
