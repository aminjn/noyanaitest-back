import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import {
  BadInputError,
  MiddlewareError,
  NotFoundError,
  NotReadyError,
} from "../Lib/AppError";
import BotChat, { IBotChat } from "../Models/Bot/BotChat";
import { isValidObjectId } from "mongoose";
import BotChatMessage from "../Models/Bot/BotChatMessage";
import * as z from "zod";
import GlobalOllamaSettings from "../Models/Bot/GlobalOllamaSettings";
import { Ollama } from "ollama";
import BotInstruction from "../Models/Bot/BotInstruction";

const ollama = new Ollama({ host: "http://84.241.5.9:11434/" });

export const getMyChats: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BotChat.find();
    res.status(200).json({ message: "getMyChats", data });
  },
);

export const getMyChat: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const chat = await BotChat.findOne({ _id: nodeId, user: req.user._id });
    if (!chat) return next(new NotFoundError());
    const messages = await BotChatMessage.find({ chat: chat._id });
    res.status(200).json({ message: "getMyChat", data: messages });
  },
);

const promptSchema = z.strictObject({ prompt: z.string() });
export const prompt: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await promptSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    let chat: IBotChat | null | undefined;
    const { nodeId } = req.params;
    if (nodeId) {
      if (!isValidObjectId(nodeId)) return next(new BadInputError());
      chat = await BotChat.findOne({ user: req.user._id, _id: nodeId });
    } else {
      chat = await BotChat.create({ user: req.user._id });
    }
    if (!chat) return next(new NotFoundError());
    const instructions = await BotInstruction.find({ isActive: true }).sort({
      order: 1,
    });
    const messages = await BotChatMessage.find({ chat: chat._id });
    const globlaSettings = await GlobalOllamaSettings.findOne().populate({
      path: "defaultModel",
      populate: { path: "settings" },
    });
    if (!globlaSettings?.defaultModel) return next(new NotReadyError());
    const settings = globlaSettings.defaultModel.settings;
    let options = undefined;
    if (settings) {
      options = {
        numa: settings.numa,
        num_ctx: settings.num_ctx,
        num_batch: settings.num_batch,
        num_gpu: settings.num_gpu,
        main_gpu: settings.main_gpu,
        low_vram: settings.low_vram,
        f16_kv: settings.f16_kv,
        logits_all: settings.logits_all,
        vocab_only: settings.vocab_only,
        use_mmap: settings.use_mmap,
        use_mlock: settings.use_mlock,
        embedding_only: settings.embedding_only,
        num_thread: settings.num_thread,
        num_keep: settings.num_keep,
        seed: settings.seed,
        num_predict: settings.num_predict,
        top_k: settings.top_k,
        top_p: settings.top_p,
        tfs_z: settings.tfs_z,
        typical_p: settings.typical_p,
        repeat_last_n: settings.repeat_last_n,
        temperature: settings.temperature,
        repeat_penalty: settings.repeat_penalty,
        presence_penalty: settings.presence_penalty,
        frequency_penalty: settings.frequency_penalty,
        mirostat: settings.mirostat,
        mirostat_tau: settings.mirostat_tau,
        mirostat_eta: settings.mirostat_eta,
        penalize_newline: settings.penalize_newline,
        stop: settings.stop,
      };
    }
    const response = await ollama.chat({
      model: globlaSettings.defaultModel.modelName,
      messages: [
        ...instructions.map((instruction) => ({
          role: "system",
          content: instruction.content,
        })),
        ...messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        { role: "user", content: data.prompt },
      ],
      options,
      stream: true,
    });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.flushHeaders();

    let result = "";
    for await (const part of response) {
      const chunk = part.message.content;
      result += chunk;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write(`chatId: ${JSON.stringify(chat._id.toString())}\n`);
    res.write(`event: end\n`);
    res.end();
    await BotChatMessage.create({
      chat: chat._id,
      content: data.prompt,
      role: "user",
    });
    await BotChatMessage.create({
      chat: chat._id,
      content: result,
      role: "assistant",
    });
  },
);
