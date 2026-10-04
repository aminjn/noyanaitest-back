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
import { getOllamaHost } from "../Lib/aiSettings";
import BotInstruction from "../Models/Bot/BotInstruction";

// the Ollama server set in the AI settings (Lib/aiSettings.ts)
const getOllama = async () => new Ollama({ host: await getOllamaHost() });

export const getMyChats: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    // was previously unscoped (`BotChat.find()`), which returned every
    // user's wizard chats in everyone else's sidebar - scope to the
    // requesting user and show the newest conversations first.
    const data = await BotChat.find({ user: req.user._id }).sort({
      createdAt: -1,
    });
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
    const messages = await BotChatMessage.find({ chat: chat._id }).sort({
      createdAt: 1,
    });
    res.status(200).json({ message: "getMyChat", data: messages });
  },
);

export const getMyChatDetails: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const chat = await BotChat.findOne({ _id: nodeId, user: req.user._id });
    if (!chat) return next(new NotFoundError());
    res.status(200).json({ message: "getMyChatDetails", data: chat });
  },
);

export const deleteMyChat: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const chat = await BotChat.findOne({ _id: nodeId, user: req.user._id });
    if (!chat) return next(new NotFoundError());
    await BotChatMessage.deleteMany({ chat: chat._id });
    await chat.deleteOne();
    res.status(200).json({ message: "deleteMyChat" });
  },
);

// asks the model to turn the opening message into a short title, the same
// way most chat products replace "New Chat" once the topic is known. Best
// effort only: failures here should never break the actual conversation.
const buildNamingPrompt = (question: string) =>
  `Reply with only a short, specific title (three to six words, no quotation marks, no trailing punctuation) summarizing the topic of the following message, written in the same language as the message. Do not answer the message itself.\n\nMessage: "${question}"`;

const generateChatName = async (
  chatId: string,
  question: string,
  modelName: string,
): Promise<void> => {
  try {
    const response = await (await getOllama()).generate({
      model: modelName,
      prompt: buildNamingPrompt(question),
      stream: false,
    });
    const name = response.response
      ?.replace(/["'“”«»]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    if (name) await BotChat.findByIdAndUpdate(chatId, { name });
  } catch (err) {
    console.log(`[wizard] failed to name chat ${chatId}:`, err);
  }
};

const promptSchema = z.strictObject({ prompt: z.string().trim().min(1) });
export const prompt: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await promptSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());

    const { nodeId } = req.params;
    if (nodeId && !isValidObjectId(nodeId)) return next(new BadInputError());

    // check the model is actually configured before creating anything - if
    // this ran after `BotChat.create`, every failed attempt (eg. no default
    // model set, ollama host unreachable) would leave a nameless, message-less
    // chat behind in the user's sidebar forever.
    const globalSettings = await GlobalOllamaSettings.findOne().populate({
      path: "defaultModel",
      populate: { path: "settings" },
    });
    if (!globalSettings?.defaultModel) return next(new NotReadyError());

    let chat: IBotChat | null | undefined;
    if (nodeId) {
      chat = await BotChat.findOne({ user: req.user._id, _id: nodeId });
    } else {
      chat = await BotChat.create({ user: req.user._id });
    }
    if (!chat) return next(new NotFoundError());

    const instructions = await BotInstruction.find({ isActive: true }).sort({
      order: 1,
    });
    const priorMessages = await BotChatMessage.find({ chat: chat._id }).sort({
      createdAt: 1,
    });
    const isFirstMessage = priorMessages.length === 0;

    const settings = globalSettings.defaultModel.settings;
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

    // persist the user's message before we ever touch the (possibly flaky,
    // remotely-hosted) ollama server, so it's never lost even if generation
    // fails outright.
    await BotChatMessage.create({
      chat: chat._id,
      content: data.prompt,
      role: "user",
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    // send the chat id as soon as we have one, so the client can recover it
    // even if generation errors out below with nothing streamed yet
    res.write(`chatId: ${JSON.stringify(chat._id.toString())}\n`);

    let result = "";
    try {
      const response = await (await getOllama()).chat({
        model: globalSettings.defaultModel.modelName,
        messages: [
          ...instructions.map((instruction) => ({
            role: "system",
            content: instruction.content,
          })),
          ...priorMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          { role: "user", content: data.prompt },
        ],
        options,
        stream: true,
      });
      for await (const part of response) {
        const chunk = part.message.content;
        result += chunk;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    } catch (err) {
      // the ollama host is a separate remote server and can be unreachable
      // or drop mid-stream - headers are already sent at this point, so
      // throwing here would hit the default error handler post-headers-sent
      // and blow up the response instead of failing gracefully.
      console.log(
        `[wizard] ollama generation failed for chat ${chat._id}:`,
        err,
      );
      res.write(
        `event: error\nerrorMessage: ${JSON.stringify(
          "پاسخ‌گویی با خطا مواجه شد، لطفا دوباره تلاش کنید",
        )}\n\n`,
      );
    }
    res.write(`event: end\n`);
    res.end();

    if (result) {
      await BotChatMessage.create({
        chat: chat._id,
        content: result,
        role: "assistant",
      });
    }

    if (isFirstMessage && result) {
      await generateChatName(
        chat._id.toString(),
        data.prompt,
        globalSettings.defaultModel.modelName,
      );
    }
  },
);
