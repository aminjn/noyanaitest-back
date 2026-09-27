// GET /user/dashboard - everything the patient panel home needs in one
// request: the next visit (and whether its pre-visit questionnaire is
// filled), the doctor's instructions from recent visits, doctors to book
// again, and what is missing from the health profile. The assistant card
// on the page builds its suggestions from these facts.
import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { MiddlewareError } from "../Lib/AppError";
import { todayStart } from "../Lib/dateUtils";
import Reservation from "../Models/Reservation";
import VisitIntake from "../Models/VisitIntake";
import VisitNote from "../Models/VisitNote";
import UserIdentity from "../Models/UserIdentity";
import MedicalDetail from "../Models/MedicalDetail";
import UserVital from "../Models/UserVitals";
import Notification from "../Models/Notification";
import Chat from "../Models/Chat";
import Message from "../Models/Message";

const DOCTOR_FIELDS = "firstName lastName avatar slug mainSpeciality";
const doctorPopulate = { path: "doctor", select: DOCTOR_FIELDS, populate: { path: "mainSpeciality", select: "name" } };
const REBOOK_LIMIT = 4;
const RECENT_LIMIT = 3;

export const getMyPatientDashboard: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const user = req.user._id;
    const today = todayStart();

    const [upcoming, recent, identity, medical, vital, unreadNotifications, chatIds] = await Promise.all([
      Reservation.find({ user, status: { $in: ["pending", "active"] }, date: { $gte: today } })
        .sort({ date: 1, start: 1 })
        .limit(5)
        .populate([doctorPopulate, { path: "office", select: "name" }, { path: "patient", select: "givenName lastName" }])
        .select("date start end status sessionType doctor office patient chat callRoom"),
      Reservation.find({ user, status: "completed" })
        .sort({ date: -1, start: -1 })
        .limit(30)
        .populate([doctorPopulate, { path: "patient", select: "givenName lastName" }])
        .select("date start sessionType doctor patient"),
      UserIdentity.exists({ user }),
      MedicalDetail.findOne({ user }).select("height weight bloodType").lean(),
      UserVital.exists({ user }),
      Notification.countDocuments({ user, isRead: false }),
      Chat.find({ participants: user, closedAt: { $exists: false } }).distinct("_id"),
    ]);

    const next_ = upcoming[0] || null;
    const [intake, notes, unreadMessages] = await Promise.all([
      next_ ? VisitIntake.exists({ reservation: next_._id }) : null,
      recent.length
        ? VisitNote.find({
            reservation: { $in: recent.slice(0, RECENT_LIMIT).map((r) => r._id) },
            patientInstructions: { $exists: true, $ne: "" },
          })
            .select("reservation patientInstructions updatedAt")
            .lean()
        : [],
      chatIds.length
        ? Message.countDocuments({ chat: { $in: chatIds }, sender: { $ne: user }, readBy: { $ne: user } })
        : 0,
    ]);

    const instructions = new Map(notes.map((n: any) => [String(n.reservation), n.patientInstructions]));
    const recentVisits = recent.slice(0, RECENT_LIMIT).map((r) => ({
      _id: r._id,
      date: r.date,
      start: r.start,
      sessionType: r.sessionType,
      doctor: r.doctor,
      patient: r.patient,
      instructions: instructions.get(String(r._id)) || null,
    }));

    // doctors seen before, most recent first, one entry per doctor
    const seen = new Set<string>();
    const rebook: { doctor: unknown; lastVisit: Date }[] = [];
    for (const r of recent) {
      const d: any = r.doctor;
      if (!d?._id || seen.has(String(d._id))) continue;
      seen.add(String(d._id));
      rebook.push({ doctor: d, lastVisit: r.date });
      if (rebook.length >= REBOOK_LIMIT) break;
    }

    res.status(200).json({
      message: "getMyPatientDashboard",
      data: {
        next: next_ ? { ...next_.toObject(), intakeFilled: !!intake } : null,
        upcomingCount: upcoming.length,
        recentVisits,
        rebook,
        profile: {
          identity: !!identity,
          medical: !!(medical && (medical.height || medical.weight || medical.bloodType)),
          vitals: !!vital,
        },
        unreadNotifications,
        unreadMessages,
      },
    });
  },
);
