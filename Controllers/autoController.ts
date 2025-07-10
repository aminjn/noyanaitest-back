import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { Model, PopulateOptions } from "mongoose";
import { NotFoundError } from "../Lib/AppError";

export const getOne: ({ model }: { model: Model<any> }) => RequestHandler = ({
  model,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const data = await model.findById(req.params.nodeId);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getOne", data: { data } });
  });

export const getAll: ({
  model,
}: {
  model: Model<any>;
  population?: PopulateOptions | PopulateOptions[];
  selection?: Record<string, number | boolean | string | object>;
}) => RequestHandler = ({ model, population, selection }) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const query = model.find(req.query);
    if (!!selection) query.select(selection);
    if (!!population) query.populate(population);
    const data = await query;
    res.status(200).json({ message: "getAll", data: { data } });
  });

export const create: ({ model }: { model: Model<any> }) => RequestHandler = ({
  model,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    await model.create(req.body);
    res.status(200).json({ message: "create" });
  });

export const edit: ({ model }: { model: Model<any> }) => RequestHandler = ({
  model,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    await model.findByIdAndUpdate(req.params.nodeId, req.body);
    res.status(200).json({ message: "edit" });
  });

export const remove: ({ model }: { model: Model<any> }) => RequestHandler = ({
  model,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    await model.findByIdAndDelete(req.params.nodeId);
    res.status(200).json({ message: "remove" });
  });

export const getSingleton: (args: { model: Model<any> }) => RequestHandler = ({
  model,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const data = await model.findOneAndUpdate(
      {},
      {},
      { upsert: true, new: true }
    );
    res.status(200).json({ message: "getSingleton", data: { data } });
  });

export const editSingleton: (args: { model: Model<any> }) => RequestHandler = ({
  model,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    await model.findOneAndUpdate({}, req.body, { upsert: true });
    res.status(200).json({ message: "editSingleton" });
  });

export const mutateCompoundFields: (keys: string[]) => RequestHandler = (
  keys
) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    for (const key in req.body) {
      if (keys.includes(key)) {
        try {
          req.body[key] = JSON.parse(req.body[key]);
        } catch {}
      }
    }
    next();
  });
