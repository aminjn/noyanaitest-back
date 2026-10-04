// Pre-visit questionnaire (patient) and visit note + AI scribe (doctor).
// Clinical data: the doctor side is owner-only - secretaries manage the
// calendar but never read a patient's answers or the doctor's notes.
import { notifyWithSms, reservationSmsContext } from "../Services/notificationSmsService";
import { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import Reservation from "../Models/Reservation";
import VisitIntake, { intakeConditions, intakeOnsets, intakeRedFlags } from "../Models/VisitIntake";
import VisitNote from "../Models/VisitNote";
import { clinicalAiEnabled, draftVisitNote, summarizeIntake } from "../Services/clinicalAi";
import { speechToTextEnabled, transcribe } from "../Services/speechToText";

const EDITABLE = ["pending", "active"];

const trimmed = (max: number) => z.string().trim().max(max);

const intakeSchema = z.strictObject({
  complaint: trimmed(1000).min(2),
  onset: z.enum(intakeOnsets).optional(),
  severity: z.coerce.number().int().min(0).max(10).optional(),
  conditions: z.array(z.enum(intakeConditions)).max(intakeConditions.length).default([]),
  medications: trimmed(1000).optional(),
  allergies: trimmed(500).optional(),
  redFlags: z.array(z.enum(intakeRedFlags)).max(intakeRedFlags.length).default([]),
  notes: trimmed(1000).optional(),
});

// Fills the AI summary in the background; the patient never waits on it.
const refreshIntakeSummary = (intakeId: unknown) => {
  (async () => {
    if (!(await clinicalAiEnabled())) return;
    const intake = await VisitIntake.findById(intakeId).lean();
    if (!intake) return;
    const { summary, questions } = await summarizeIntake(intake);
    await VisitIntake.updateOne({ _id: intakeId }, { aiSummary: summary, aiQuestions: questions });
  })().catch((err) => console.error("intake summary failed:", err?.message || err));
};

// ---------------- patient ----------------

// GET /user/reservation/:nodeId/intake
export const getMyIntake: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const reservation = await Reservation.findOne({ _id: nodeId, user: req.user._id }).select("status");
    if (!reservation) return next(new NotFoundError());
    const intake = await VisitIntake.findOne({ reservation: reservation._id })
      .select("-aiSummary -aiQuestions")
      .lean();
    res.status(200).json({
      message: "getMyIntake",
      data: { intake, editable: EDITABLE.includes(reservation.status) },
    });
  },
);

// PUT /user/reservation/:nodeId/intake
export const saveMyIntake: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = intakeSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const reservation = await Reservation.findOne({ _id: nodeId, user: req.user._id }).select("status");
    if (!reservation) return next(new NotFoundError());
    if (!EDITABLE.includes(reservation.status))
      return next(new AppError("پرسش‌نامه‌ی این نوبت دیگر قابل ویرایش نیست", 400));
    const now = new Date();
    const intake = await VisitIntake.findOneAndUpdate(
      { reservation: reservation._id },
      {
        $set: { ...parsed.data, user: req.user._id, updatedAt: now, aiQuestions: [] },
        $unset: { aiSummary: 1 },
        $setOnInsert: { submittedAt: now },
      },
      { upsert: true, new: true, runValidators: true },
    ).select("-aiSummary -aiQuestions");
    refreshIntakeSummary(intake?._id);
    res.status(200).json({ message: "saveMyIntake", data: { intake, editable: true } });
  },
);

// ---------------- doctor ----------------

const ownReservation = async (req: Request, next: NextFunction) => {
  if (!req.doctor) {
    next(new MiddlewareError());
    return null;
  }
  if (req.aclGrant !== "FULL") {
    next(new AppError("فقط خود پزشک به پرونده‌ی بالینی این ویزیت دسترسی دارد", 403));
    return null;
  }
  const { nodeId } = req.params;
  if (!isValidObjectId(nodeId)) {
    next(new BadInputError());
    return null;
  }
  const reservation = await Reservation.findOne({ _id: nodeId, doctor: req.doctor._id }).select("_id status");
  if (!reservation) {
    next(new NotFoundError());
    return null;
  }
  return reservation;
};

// GET /doctor/reservation/:nodeId/visit - intake, note and what the
// server can do (so the UI hides the mic / draft buttons when off)
export const getVisitRecord: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const reservation = await ownReservation(req, next);
    if (!reservation) return;
    const [intake, note] = await Promise.all([
      VisitIntake.findOne({ reservation: reservation._id }).lean(),
      VisitNote.findOne({ reservation: reservation._id }).lean(),
    ]);
    res.status(200).json({
      message: "getVisitRecord",
      data: { intake, note, capabilities: { ai: await clinicalAiEnabled(), stt: await speechToTextEnabled() } },
    });
  },
);

const noteSchema = z.strictObject({
  subjective: trimmed(5000).optional(),
  objective: trimmed(5000).optional(),
  assessment: trimmed(5000).optional(),
  plan: trimmed(5000).optional(),
  patientInstructions: trimmed(3000).optional(),
  transcript: trimmed(30000).optional(),
  aiAssisted: z.boolean().optional(),
});

// PUT /doctor/reservation/:nodeId/visit/note
export const saveVisitNote: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const reservation = await ownReservation(req, next);
    if (!reservation) return;
    const now = new Date();
    // instructions written for the first time: the patient is told (once)
    const before = await VisitNote.findOne({ reservation: reservation._id })
      .select("patientInstructions")
      .lean<{ patientInstructions?: string }>();
    const note = await VisitNote.findOneAndUpdate(
      { reservation: reservation._id },
      {
        $set: { ...parsed.data, doctor: req.doctor!._id, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, new: true, runValidators: true },
    );
    res.status(200).json({ message: "saveVisitNote", data: note });
    if (!before?.patientInstructions?.trim() && note?.patientInstructions?.trim()) {
      const ctx = await reservationSmsContext(reservation._id).catch(() => null);
      if (ctx)
        notifyWithSms(
          "visitNoteReadyPatient",
          ctx.patientUser,
          { reservationId: ctx.reservationId, doctorName: ctx.doctorName },
          {
            phone: ctx.patientPhone,
            notification: {
              title: "توصیه‌های پزشک برای ویزیت شما آماده است",
              message: "پزشک توصیه‌های پس از ویزیت را ثبت کرد. آن‌ها را در صفحه‌ی نوبت ببینید.",
              link: `/dashboard/booking/${ctx.reservationId}`,
            },
          },
        );
    }
  },
);

// POST /doctor/reservation/:nodeId/visit/draft {transcript} - returns a
// SOAP draft; nothing is saved until the doctor saves the note
export const draftNote: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = z.strictObject({ transcript: trimmed(30000) }).safeParse(req.body);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    if (parsed.data.transcript.length < 10) return next(new AppError("متن ویزیت خالی است", 400));
    if (!(await clinicalAiEnabled())) return next(new AppError("دستیار هوش مصنوعی روی این سرور فعال نیست", 503));
    const reservation = await ownReservation(req, next);
    if (!reservation) return;
    const intake = await VisitIntake.findOne({ reservation: reservation._id }).lean();
    try {
      const draft = await draftVisitNote(parsed.data.transcript, intake);
      res.status(200).json({ message: "draftNote", data: draft });
    } catch (err: any) {
      console.error("note draft failed:", err?.message || err);
      next(new AppError("دستیار نتوانست پیش‌نویس بسازد؛ دوباره تلاش کنید", 502));
    }
  },
);

// Up to ~20 minutes of opus audio; kept in memory only.
export const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^audio\//.test(file.mimetype) || file.mimetype === "video/webm"),
}).single("audio");

// POST /doctor/reservation/:nodeId/visit/transcribe (multipart "audio")
export const transcribeVisit: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!(await speechToTextEnabled())) return next(new AppError("تبدیل گفتار به متن روی این سرور فعال نیست", 503));
    const reservation = await ownReservation(req, next);
    if (!reservation) return;
    if (!req.file?.buffer?.length) return next(new AppError("فایل صوتی ارسال نشده است", 400));
    try {
      const text = await transcribe(req.file.buffer, req.file.mimetype, req.file.originalname);
      res.status(200).json({ message: "transcribeVisit", data: { text } });
    } catch (err: any) {
      console.error("transcription failed:", err?.message || err);
      next(new AppError("تبدیل صدا به متن انجام نشد؛ دوباره تلاش کنید", 502));
    }
  },
);
