import express, { RequestHandler } from "express";
import { Model, PopulateOptions } from "mongoose";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";
import Blog from "../Models/Blog";
import BlogCategory from "../Models/BlogCategory";

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
      router
        .route(`/${segment.name}/:nodeId`)
        .get(
          authController.protect,
          authController.restrictTo("admin"),
          autoController.getOne({ model: segment.model })
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
