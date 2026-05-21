import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";

import { Ollama } from "ollama";
import OllamaModel from "../Models/Bot/OllamaModel";
import { NotFoundError } from "../Lib/AppError";
import ModelOptions from "../Models/Bot/ModelSettings";
import { Model } from "mongoose";

const ollama = new Ollama({ host: "http://84.241.5.9:11434/" });

export const refreshModels: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const models = await ollama.list();
    const running = await ollama.ps();
    for (const model of models.models) {
      await OllamaModel.findOneAndUpdate(
        { name: model.name },
        {
          name: model.name,
          modelName: model.model,
          modifiedAt: model.modified_at,
          size: model.size,
          digest: model.digest,
          family: model.details.family,
          parameterSize: model.details.parameter_size,
          quantizationLevel: model.details.quantization_level,
          loaded: running.models.some((m) => m.name === model.name),
        },
        { upsert: true },
      );
    }
    res
      .status(200)
      .json({ message: "refreshModels", data: { running, models } });
  },
);

export const loadModel: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    const model = await OllamaModel.findById(nodeId);
    if (!model) return next(new NotFoundError());
    const response = await ollama.generate({
      model: model.modelName,
      prompt: "",
      keep_alive: -1,
      options: {},
    });
    res.status(200).json({ message: "loadModel", data: response });
  },
);

export const unloadModel: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    const model = await OllamaModel.findById(nodeId);
    if (!model) return next(new NotFoundError());
    const response = await ollama.generate({
      model: model.modelName,
      prompt: "",
      keep_alive: 0,
    });
    res.status(200).json({ message: "unloadModel", data: response });
  },
);

export const getSettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await ModelOptions.findOne();
    res.status(200).json({ message: "getSettings", data });
  },
);

export const changeSettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await ModelOptions.deleteMany();
    await ModelOptions.create(req.body);
    res.status(200).json({ message: "changeSettings" });
  },
);

export const getModelSettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    const model = await OllamaModel.findById(nodeId);
    if (!model) return next(new NotFoundError());
    const settings = await ModelOptions.findOne({ ollamaModel: model._id });
    res.status(200).json({ message: "getModelSettings", data: settings });
  },
);

export const setModelSettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    const model = await OllamaModel.findById(nodeId);
    if (!model) return next(new NotFoundError());
    await ModelOptions.findOneAndDelete({ ollamaModel: model._id });
    await ModelOptions.create({ ollamaModel: model._id, ...req.body });
    res.status(200).json({ message: "setModelSettings" });
  },
);

export const restoreDefaultModelSettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    const model = await OllamaModel.findById(nodeId);
    if (!model) return next(new NotFoundError());
    await ModelOptions.findOneAndDelete({ ollamaModel: model._id });
    res.status(200).json({ message: "restoreDefaultModelSettings" });
  },
);
