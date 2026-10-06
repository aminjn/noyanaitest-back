import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import { MiddlewareError, NotFoundError } from "../Lib/AppError";
import DoctorPatient from "../Models/DoctorPatient";
import Reservation from "../Models/Reservation";
import VisitNote from "../Models/VisitNote";
import UserIdentity from "../Models/UserIdentity";
import PatientProfile from "../Models/PatiantProfile";
import PatientProfileRecord from "../Models/PatientProfileRecord";
import Prescription2 from "../Models/Prescription/Prescription2";

const MAX_EVENTS = 200;

const clip = (text: unknown, max = 240) => {
  const s = typeof text === "string" ? text.trim() : "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

// GET /doctor/patient/:nodeId/timeline (DoctorPatient id) - the patient's
// story with this doctor in one list, newest first (Doctolib / Practo Ray's
// patient file): visits with their outcome, the visit note's assessment and
// plan, prescriptions and the doctor's own records. Clinical text (notes,
// prescriptions) is the owner's only; a secretary sees visits and records.
export const getPatientTimeline: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const dp = await DoctorPatient.findOne({ _id: nodeId, doctor: req.doctor._id }).select("user").lean();
    if (!dp?.user) return next(new NotFoundError());
    const isOwner = req.aclGrant === "FULL";
    const userId = dp.user;

    // the account's own identity, plus anyone it booked for with this doctor
    const ownIdentities = await UserIdentity.find({ user: userId }).select("_id").lean();
    const reservations = await Reservation.find({
      doctor: req.doctor._id,
      $or: [{ user: userId }, { patient: { $in: ownIdentities.map((i) => i._id) } }],
    })
      .sort({ date: -1, start: -1 })
      .limit(MAX_EVENTS)
      .populate([
        { path: "office", select: "name" },
        { path: "patient", select: "givenName lastName" },
      ])
      .select("date start end status sessionType office patient noShowParty source cancelledBy")
      .lean();
    const identityIds = [
      ...new Set([
        ...ownIdentities.map((i) => String(i._id)),
        ...reservations.map((r: any) => String(r.patient?._id || r.patient || "")).filter(Boolean),
      ]),
    ];

    const [notes, prescriptions, profiles] = await Promise.all([
      isOwner && reservations.length
        ? VisitNote.find({ reservation: { $in: reservations.map((r) => r._id) }, doctor: req.doctor._id })
            .select("reservation assessment plan subjective updatedAt aiAssisted")
            .lean()
        : Promise.resolve([]),
      isOwner && identityIds.length
        ? Prescription2.find({ author: req.doctor._id, patient: { $in: identityIds } })
            .sort({ createdAt: -1 })
            .limit(MAX_EVENTS)
            .lean()
        : Promise.resolve([]),
      PatientProfile.find({ user: userId }).select("_id title").lean(),
    ]);
    const records = profiles.length
      ? await PatientProfileRecord.find({
          profile: { $in: profiles.map((p: any) => p._id) },
          ...(isOwner ? {} : { isPublic: true }),
        })
          .sort({ createdAt: -1 })
          .limit(MAX_EVENTS)
          .select("profile title description createdAt files author")
          .lean()
      : [];

    const noteOf = new Map(notes.map((n: any) => [String(n.reservation), n]));
    const profileTitle = new Map(profiles.map((p: any) => [String(p._id), p.title]));
    const events = [
      ...reservations.map((r: any) => {
        const note: any = noteOf.get(String(r._id));
        const at = new Date(r.date).getTime() + (Number(r.start) || 0) * 60000;
        return {
          kind: "visit" as const,
          id: String(r._id),
          at: new Date(at),
          status: r.status,
          sessionType: r.sessionType,
          start: r.start,
          end: r.end,
          office: r.office?.name || null,
          // booked for a relative of the account
          patientName: [r.patient?.givenName, r.patient?.lastName].filter(Boolean).join(" ") || null,
          noShowParty: r.noShowParty || null,
          desk: r.source === "desk",
          note: note
            ? {
                assessment: clip(note.assessment),
                plan: clip(note.plan),
                subjective: note.assessment || note.plan ? "" : clip(note.subjective),
                aiAssisted: !!note.aiAssisted,
              }
            : null,
        };
      }),
      ...prescriptions.map((p: any) => ({
        kind: "prescription" as const,
        id: String(p._id),
        at: p.createdAt,
        items: Array.isArray(p.items) ? p.items.length : 0,
        labItems: Array.isArray(p.labItems) ? p.labItems.length : 0,
      })),
      ...records.map((r: any) => ({
        kind: "record" as const,
        id: String(r._id),
        at: r.createdAt,
        title: r.title || "",
        description: clip(r.description),
        files: Array.isArray(r.files) ? r.files.length : 0,
        profile: String(r.profile),
        profileTitle: profileTitle.get(String(r.profile)) || "",
      })),
    ]
      .filter((e) => !isNaN(new Date(e.at).getTime()))
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, MAX_EVENTS);

    const stats = {
      visits: reservations.filter((r) => r.status === "completed").length,
      missed: reservations.filter((r: any) => r.status === "noShow" && r.noShowParty === "patient").length,
      cancelled: reservations.filter((r) => r.status === "cancelled").length,
      upcoming: reservations.filter((r) => ["pending", "active"].includes(r.status)).length,
    };
    res.status(200).json({ message: "getPatientTimeline", data: { events, stats, clinical: isOwner } });
  },
);
