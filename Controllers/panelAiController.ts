// AI in every panel (2026-10): «دستیار نویان» per profile, voice
// prescription, chat reply suggestions, patient summary, CRM texts, call
// analysis, and speech-to-text for all of them. Routes: Routers/panelAiRouter.ts.
// Provider rules: Lib/ai/panelAi.ts; access and limits: the AI policy
// (Lib/ai/aiGate.ts checkAndConsumeAi). A use the model did not answer is
// given back (refundRequestAi).
import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import {
  aiFailure,
  hasPlanModule,
  NOT_CONFIGURED,
  NOT_IN_PLAN,
  orgOf,
  panelAiStatus,
  panelOf,
  STT_NOT_CONFIGURED,
} from "../Lib/ai/panelAi";
import { aiFeatureStates, checkAndConsumeAi, refundRequestAi, subjectOf } from "../Lib/ai/aiGate";
import { getAiSettings } from "../Lib/aiSettings";
import { clearHistory, getHistory, makeCtx, runCopilot, toolNames } from "../Lib/ai/copilot/engine";
import { Profile } from "../Lib/ai/copilot/types";
import { transcribe } from "../Services/speechToText";
import { parsePrescription } from "../Services/rxParser";
import { analyzeCall, chatSuggestions, contactInsight, crmActionPlan, crmTemplateText, patientSummary } from "../Services/panelAiFeatures";
import { isPro } from "../Lib/patientPro";
import { ownerOfReq } from "./businessController";
import { NodeWithAcl } from "../Lib/enums";

// ---------------- status ----------------

// GET /ai/:name/status - what the panel may show (plan, provider, limits,
// the ACL of the AI tools, the copilot tools open to this user)
export const orgStatus: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const name = panelOf(req);
  if (!name || !orgOf(req)) return next(new MiddlewareError());
  const [status, tools] = await Promise.all([panelAiStatus(req, res), toolNames(makeCtx(req, res, name))]);
  res.status(200).json({ message: "panelAiStatus", data: { ...status, tools } });
});

// GET /ai/user/status and /ai/admin/status
export const selfStatus = (profile: "user" | "admin"): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const settings = await getAiSettings();
    const ctx = makeCtx(req, res, profile);
    const copilot = profile === "user" ? "assistant.copilot.patient" : "staff.copilot";
    const [tools, features, pro] = await Promise.all([
      toolNames(ctx),
      aiFeatureStates(subjectOf(req, copilot)),
      profile === "user" ? isPro(req.user._id) : Promise.resolve(undefined),
    ]);
    const own = features[copilot];
    res.status(200).json({
      message: "panelAiStatus",
      data: {
        panel: profile,
        inPlan: !!own && own.state !== "notInPlan" && own.state !== "off",
        configured: !!settings.clinical,
        stt: !!settings.stt,
        owner: true,
        limit: own?.limit || 0,
        used: own?.used || 0,
        ...(pro === undefined ? {} : { pro }),
        features,
        tools,
      },
    });
  });

// ---------------- copilot ----------------

const askSchema = z.object({ text: z.string().trim().min(1).max(2000), page: z.string().max(200).optional() });

const answer = async (req: Request, res: Response, profile: Profile) => {
  const parsed = askSchema.safeParse(req.body || {});
  if (!parsed.success) throw new BadInputError();
  try {
    return await runCopilot(makeCtx(req, res, profile), parsed.data.text, parsed.data.page);
  } catch (err) {
    console.error("copilot failed:", (err as Error)?.message || err);
    await refundRequestAi(req);
    throw aiFailure(err);
  }
};

// POST /ai/:name/copilot {text, page} (gate: panelAiGate("copilot"))
export const orgCopilot: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const data = await answer(req, res, panelOf(req)!);
  res.status(200).json({ message: "copilot", data });
});

// POST /ai/user/copilot - the patient's own allowance (feature
// "assistant.copilot.patient": free tier / Pro); a failed answer gives it back
export const userCopilot: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  if (!(await getAiSettings()).clinical) return next(new AppError(NOT_CONFIGURED, 503));
  await checkAndConsumeAi(req, "assistant.copilot.patient");
  const data = await answer(req, res, "user");
  res.status(200).json({ message: "copilot", data });
});

// POST /ai/admin/copilot - staff have their own feature ("staff.copilot")
export const adminCopilot: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  if (!(await getAiSettings()).clinical) return next(new AppError(NOT_CONFIGURED, 503));
  await checkAndConsumeAi(req, "staff.copilot");
  const data = await answer(req, res, "admin");
  res.status(200).json({ message: "copilot", data });
});

const profileFor = (req: Request, fixed?: Profile) => fixed || panelOf(req);

export const history = (fixed?: Profile): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const p = profileFor(req, fixed);
    if (!p || !req.user) return next(new MiddlewareError());
    const items = await getHistory(makeCtx(req, res, p));
    res.status(200).json({ message: "copilotHistory", data: items });
  });

export const deleteHistory = (fixed?: Profile): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const p = profileFor(req, fixed);
    if (!p || !req.user) return next(new MiddlewareError());
    await clearHistory(makeCtx(req, res, p));
    res.status(200).json({ message: "copilotHistoryCleared" });
  });

// ---------------- speech to text ----------------

// POST /ai/<profile>/transcribe (multipart "audio") - kept in memory only
export const transcribeAudio = (fixed?: "user" | "admin"): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    if (!req.file?.buffer?.length) {
      await refundRequestAi(req);
      return next(new AppError("فایل صوتی ارسال نشده است", 400));
    }
    // a panel's gate counted it already (minutes of the audio)
    if (fixed) {
      if (!(await getAiSettings()).stt) return next(new AppError(STT_NOT_CONFIGURED, 503));
      await checkAndConsumeAi(req, fixed === "user" ? "assistant.voice.patient" : "staff.voice", { units: "audio" });
    }
    try {
      const text = await transcribe(req.file.buffer, req.file.mimetype, req.file.originalname);
      res.status(200).json({ message: "transcribe", data: { text } });
    } catch (err) {
      await refundRequestAi(req);
      console.error("transcription failed:", (err as Error)?.message || err);
      next(new AppError("تبدیل صدا به متن انجام نشد؛ دوباره تلاش کنید", 502));
    }
  });

// ---------------- voice prescription ----------------

const rxSchema = z.object({
  text: z.string().trim().min(2).max(4000),
  patient: z.string().max(30).optional().nullable(),
  existing: z
    .array(z.object({ service: z.string().max(30).optional(), name: z.string().max(300).optional() }))
    .max(60)
    .optional(),
});

// POST /ai/doctor/rx/parse {text, patient?, existing?} - the dictated or
// typed prescription as a draft for the form (Services/rxParser.ts)
export const parseRx: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = rxSchema.safeParse(req.body || {});
  if (!parsed.success) return next(new BadInputError());
  if (!(await hasPlanModule(req, res, "drugsAndPrescriptions"))) {
    await refundRequestAi(req);
    return next(new AppError(NOT_IN_PLAN, 403));
  }
  try {
    const data = await parsePrescription({
      text: parsed.data.text,
      patient: parsed.data.patient || undefined,
      existing: parsed.data.existing,
      doctorId: req.doctor?._id,
    });
    res.status(200).json({ message: "parseRx", data });
  } catch (err) {
    console.error("rx parse failed:", (err as Error)?.message || err);
    await refundRequestAi(req);
    next(aiFailure(err));
  }
});

// ---------------- chat, patient ----------------

// POST /ai/doctor/chat/:chatId/suggest
export const suggestChat: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const owner = req.doctor?.user as unknown as { _id?: unknown } | undefined;
  const actor = (owner?._id ?? owner) as never;
  if (!actor) return next(new MiddlewareError());
  try {
    const data = await chatSuggestions(String(req.params.chatId), actor);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "suggestChat", data });
  } catch (err) {
    console.error("chat suggestions failed:", (err as Error)?.message || err);
    await refundRequestAi(req);
    next(aiFailure(err));
  }
});

// POST /ai/doctor/patient/:nodeId/summary (DoctorPatient id; owner only)
export const summarizePatient: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!(await hasPlanModule(req, res, "patients"))) {
    await refundRequestAi(req);
    return next(new AppError(NOT_IN_PLAN, 403));
  }
  try {
    const data = await patientSummary(req.doctor?._id, String(req.params.nodeId));
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "summarizePatient", data });
  } catch (err) {
    console.error("patient summary failed:", (err as Error)?.message || err);
    await refundRequestAi(req);
    next(aiFailure(err));
  }
});

// ---------------- CRM ----------------

const owner = (req: Request) => ownerOfReq(panelOf(req) as NodeWithAcl)(req);

// POST /ai/:name/crm/template {goal} - an SMS template draft
export const crmTemplate: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = z.object({ goal: z.string().trim().min(3).max(600) }).safeParse(req.body || {});
  if (!parsed.success) return next(new AppError("هدف پیامک را بنویسید", 400));
  const org = orgOf(req) as unknown as { name?: string; firstName?: string; lastName?: string };
  const orgName = org?.name || [org?.firstName, org?.lastName].filter(Boolean).join(" ");
  try {
    res.status(200).json({ message: "crmTemplateText", data: await crmTemplateText(parsed.data.goal, orgName || "") });
  } catch (err) {
    await refundRequestAi(req);
    next(aiFailure(err));
  }
});

// POST /ai/:name/crm/plan - today's action plan (Nexxa CRM copilot)
export const crmPlan: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const o = owner(req);
  if (!o) return next(new MiddlewareError());
  try {
    res.status(200).json({ message: "crmPlan", data: await crmActionPlan(o) });
  } catch (err) {
    await refundRequestAi(req);
    next(aiFailure(err));
  }
});

// POST /ai/:name/crm/contact/:contactId/insight
export const crmContactInsight: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const o = owner(req);
  if (!o) return next(new MiddlewareError());
  try {
    const data = await contactInsight(o, String(req.params.contactId));
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "crmContactInsight", data });
  } catch (err) {
    await refundRequestAi(req);
    next(aiFailure(err));
  }
});

// POST /ai/:name/call/analyze (multipart "audio", or {transcript}) - a
// patient phone call: transcript + analysis; nothing is stored
export const analyzeCallAudio: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  let transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim().slice(0, 30000) : "";
  if (req.file?.buffer?.length) {
    if (!(await getAiSettings()).stt) return next(new AppError(STT_NOT_CONFIGURED, 503));
    try {
      transcript = await transcribe(req.file.buffer, req.file.mimetype, req.file.originalname);
    } catch (err) {
      console.error("call transcription failed:", (err as Error)?.message || err);
      await refundRequestAi(req);
      return next(new AppError("تبدیل صدا به متن انجام نشد؛ دوباره تلاش کنید", 502));
    }
  }
  if (transcript.length < 10) return next(new AppError("متن تماس خالی است", 400));
  try {
    const analysis = await analyzeCall(transcript);
    res.status(200).json({ message: "analyzeCall", data: { transcript, analysis } });
  } catch (err) {
    console.error("call analysis failed:", (err as Error)?.message || err);
    await refundRequestAi(req);
    next(aiFailure(err));
  }
});

