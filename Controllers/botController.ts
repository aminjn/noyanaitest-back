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
import { ChatRequest, Ollama } from "ollama";
import { getAiSettings, getOllamaClientConfig } from "../Lib/aiSettings";
import BotInstruction from "../Models/Bot/BotInstruction";
import { readTriage, titleLanguageHint, triagePrompt, TriageMeta } from "../Lib/wizardTriage";
import { assessmentBrief, fallbackAssessment, nextStep } from "../Lib/triage/interviewFlow";
import { aboutSomeoneElse, describePatient, patientContext } from "../Lib/triage/patientContext";
import AppError from "../Lib/AppError";
import { checkAndConsumeAi, refundRequestAi } from "../Lib/ai/aiGate";

// the Ollama server set in the AI settings (Lib/aiSettings.ts)
const getOllama = async () => new Ollama(await getOllamaClientConfig());

// A reply streamed from the model within limits (2026-10: a small model on
// a busy CPU kept the patient on «...» for ten minutes): no first word
// within `firstMs`, or no end within `totalMs`, aborts it. Returns what
// came, and whether it was cut.
const streamWithLimits = async (
  request: ChatRequest & { stream: true },
  onChunk: (chunk: string) => void,
  { firstMs, totalMs }: { firstMs: number; totalMs: number },
): Promise<{ text: string; timedOut: boolean }> => {
  // the request's own signal: ollama.abort() cannot stop a request whose
  // reply has not started streaming yet (a model still loading)
  const ctl = new AbortController();
  const ollama = new Ollama({
    ...(await getOllamaClientConfig()),
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([ctl.signal, init.signal]) : ctl.signal }),
  });
  let text = "";
  let timedOut = false;
  let first: NodeJS.Timeout | undefined;
  const cut = () => {
    timedOut = true;
    ctl.abort();
    try {
      ollama.abort();
    } catch {
      /* already over */
    }
  };
  first = setTimeout(cut, firstMs);
  const total = setTimeout(cut, totalMs);
  try {
    const response = await ollama.chat(request);
    for await (const part of response) {
      if (first) {
        clearTimeout(first);
        first = undefined;
      }
      const chunk = part.message?.content || "";
      text += chunk;
      if (chunk) onChunk(chunk);
    }
  } catch (err) {
    if (!timedOut) throw err;
  } finally {
    if (first) clearTimeout(first);
    clearTimeout(total);
  }
  return { text, timedOut };
};

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
  `Reply with only a short, specific title (three to six words, no quotation marks, no trailing punctuation) summarizing the topic of the following message, written in ${titleLanguageHint(question)}. Do not translate it into English. Do not answer the message itself.\n\nMessage: "${question}"`;

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
    let name = response.response
      ?.replace(/["'“”«»]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    // a Persian question titled in another language: its own first words
    if (/[\u0600-\u06FF]/.test(question) && !(name && /[\u0600-\u06FF]/.test(name)))
      name = question.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ").slice(0, 60);
    if (name) await BotChat.findByIdAndUpdate(chatId, { name });
  } catch (err) {
    console.log(`[wizard] failed to name chat ${chatId}:`, err);
  }
};

// bounded: the prompt is stored and sent to the model with the history
const promptSchema = z.strictObject({ prompt: z.string().trim().min(1).max(8000) });
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
    // the model chosen for the health chat in system settings -> AI, else
    // the bot settings' default model (with its tuning options)
    const chatAi = (await getAiSettings()).chat;
    if (!chatAi) return next(new NotReadyError());
    const globalSettings = await GlobalOllamaSettings.findOne().populate({
      path: "defaultModel",
      populate: { path: "settings" },
    });
    const chatModel = chatAi.model || globalSettings?.defaultModel?.modelName;
    if (!chatModel) return next(new NotReadyError());

    // the day's message allowance: the AI policy's "assistant.health"
    // (2026-10, Lib/ai/aiGate.ts) - the free tier's messages, a «پرو»
    // member's own cap or none. A 429 carries `ai` (reset time, upgrade).
    await checkAndConsumeAi(req, "assistant.health");

    let chat: IBotChat | null | undefined;
    if (nodeId) {
      chat = await BotChat.findOne({ user: req.user._id, _id: nodeId });
    } else {
      chat = await BotChat.create({ user: req.user._id });
    }
    if (!chat) {
      await refundRequestAi(req);
      return next(new NotFoundError());
    }

    const instructions = await BotInstruction.find({ isActive: true }).sort({
      order: 1,
    });
    const priorMessages = await BotChatMessage.find({ chat: chat._id }).sort({
      createdAt: 1,
    });
    const isFirstMessage = priorMessages.length === 0;

    const settings =
      !chatAi.model || chatAi.model === globalSettings?.defaultModel?.modelName ? globalSettings?.defaultModel?.settings : undefined;
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

    // the site's own interview for the body area the patient named
    // (Lib/triage/interviews.ts): its questions and an emergency need no
    // model (nor the day's allowance); the model writes the assessment
    // the verified identity (Shahkar) and health profile: the name to
    // address, the age and sex not to ask again
    const patient = await patientContext(req.user._id);
    const step = nextStep(
      priorMessages.map((m) => ({ role: m.role, content: m.content, meta: m.meta as never })),
      data.prompt,
      patient,
    );
    if (step.kind === "ask" || step.kind === "emergency") {
      const meta = step.kind === "ask" ? { options: step.options, interview: step.interview } : { urgency: "emergency" as const };
      res.write(`data: ${JSON.stringify(step.text)}\n\n`);
      res.write(`meta: ${JSON.stringify(meta)}\n\n`);
      res.write(`event: end\n`);
      res.end();
      await refundRequestAi(req);
      await BotChatMessage.create({ chat: chat._id, content: step.text, role: "assistant", meta });
      // the patient's own words name the chat, at once (no model call)
      if (isFirstMessage)
        await BotChat.findByIdAndUpdate(chat._id, { name: data.prompt.replace(/\s+/g, " ").trim().slice(0, 60) });
      return;
    }
    const patientText =
      step.kind === "assess"
        ? step.patientText
        : [...priorMessages.filter((m) => m.role === "user").map((m) => m.content), data.prompt].join("\n");

    const firstLine = [...priorMessages.filter((m) => m.role === "user").map((m) => m.content), data.prompt][0] || data.prompt;
    const patientLine = describePatient(patient, !aboutSomeoneElse(firstLine));
    let result = "";
    let failed = false;
    try {
      const out = await streamWithLimits(
        {
          model: chatModel,
          messages:
            step.kind === "assess"
              ? // one short brief with every answer in it: fast on a small model
                [
                  ...(chatAi.instruction ? [{ role: "system", content: chatAi.instruction }] : []),
                  { role: "system", content: assessmentBrief(step, patientLine) },
                  { role: "user", content: firstLine },
                ]
              : [
                  ...(chatAi.instruction ? [{ role: "system", content: chatAi.instruction }] : []),
                  ...instructions.map((instruction) => ({
                    role: "system",
                    content: instruction.content,
                  })),
                  // the site's own protocol last: it has the final word
                  { role: "system", content: [await triagePrompt(), patientLine].filter(Boolean).join("\n") },
                  ...priorMessages.map((message) => ({
                    role: message.role,
                    content: message.content,
                  })),
                  { role: "user", content: data.prompt },
                ],
          options,
          stream: true,
        },
        (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`),
        step.kind === "assess" ? { firstMs: 60_000, totalMs: 150_000 } : { firstMs: 90_000, totalMs: 240_000 },
      );
      result = out.text;
      if (out.timedOut) console.log(`[wizard] model timed out for chat ${chat._id} (${result.length} chars came)`);
    } catch (err) {
      // the ollama host is a separate remote server and can be unreachable
      // or drop mid-stream - headers are already sent at this point, so
      // throwing here would hit the default error handler post-headers-sent
      // and blow up the response instead of failing gracefully.
      console.log(
        `[wizard] ollama generation failed for chat ${chat._id}:`,
        err,
      );
      failed = true;
    }
    // the interview is over but the model did not answer (in time): the
    // site writes the assessment itself, so the patient is never left waiting
    if (step.kind === "assess" && result.replace(/\[\[[^\]]*\]\]/g, "").trim().length < 40) {
      const text = fallbackAssessment(step, patient.name);
      res.write(`data: ${JSON.stringify((result ? "\n\n" : "") + text)}\n\n`);
      result = result ? `${result}\n\n${text}` : text;
      failed = false;
    }
    if (failed && !result)
      res.write(
        `event: error\nerrorMessage: ${JSON.stringify(
          "پاسخ‌گویی با خطا مواجه شد، لطفا دوباره تلاش کنید",
        )}\n\n`,
      );
    // the assessment's machine lines -> the specialty and the conditions the
    // site has pages for; the stored reply keeps only what the patient reads
    const triage = result ? await readTriage(result, patientText, step.kind === "assess" ? { assessment: true, urgency: step.urgency } : {}).catch(() => ({ text: result, meta: {} as TriageMeta })) : null;
    if (triage && Object.keys(triage.meta).length)
      res.write(`meta: ${JSON.stringify(triage.meta)}\n\n`);
    res.write(`event: end\n`);
    res.end();
    // an unanswered message does not use up the day's allowance
    if (!result) await refundRequestAi(req);

    if (triage) {
      await BotChatMessage.create({
        chat: chat._id,
        content: triage.text,
        role: "assistant",
        ...(Object.keys(triage.meta).length ? { meta: triage.meta } : {}),
      });
    }

    if (isFirstMessage && result) {
      await generateChatName(
        chat._id.toString(),
        data.prompt,
        chatModel,
      );
    }
  },
);
