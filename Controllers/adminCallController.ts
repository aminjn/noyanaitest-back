import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, NotFoundError } from "../Lib/AppError";
import CallRoom, { callStatuses, callTypes } from "../Models/CallRoom";
import CallParticipant from "../Models/CallParticipant";
import CallEvent from "../Models/CallEvent";
import CallRecording from "../Models/CallRecording";
import DoctorProfile from "../Models/DoctorProfile";
import Reservation from "../Models/Reservation";
import { searchUserIds } from "../Lib/adminListing";

// Calls in the super admin back office (2026-10, audit P3-18): every voice /
// video room with the reservation it belongs to, who joined and for how long
// (CallParticipant / CallEvent) and its recordings (metadata only - the
// recording files themselves stay on the call server). Read-only: rooms are
// still created and ended only through callService (/admin/call/create,
// /admin/call/:id/end).

const MAX_LIMIT = 100;
const USER_FIELDS = "phone username";

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(callStatuses).optional(),
  callType: z.enum(callTypes).optional(),
  // a DoctorProfile: its account took part, or the room is one of its visits
  doctor: z.string().refine(isValidObjectId).optional(),
  // a User (patient or anyone) who took part
  user: z.string().refine(isValidObjectId).optional(),
  reservation: z.string().refine(isValidObjectId).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(25),
});

const durationSeconds = (room: any) => {
  const from = room.connectedAt ? new Date(room.connectedAt).getTime() : NaN;
  const to = room.endedAt ? new Date(room.endedAt).getTime() : room.status === "active" ? Date.now() : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && to >= from
    ? Math.round((to - from) / 1000)
    : null;
};

// GET /admin/calls
export const listCalls: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const input = parsed.data;
    const and: Record<string, unknown>[] = [];
    if (input.status) and.push({ status: input.status });
    if (input.callType) and.push({ callType: input.callType });
    if (input.reservation) and.push({ reservation: input.reservation });
    if (input.user) and.push({ participants: input.user });
    if (input.from || input.to)
      and.push({
        startedAt: {
          ...(input.from && { $gte: input.from }),
          ...(input.to && { $lte: input.to }),
        },
      });
    if (input.doctor) {
      const doctor = await DoctorProfile.findById(input.doctor).select("user").lean();
      if (!doctor) return next(new NotFoundError("پزشک"));
      const visits = await Reservation.find({ doctor: doctor._id, callRoom: { $exists: true } })
        .select("_id")
        .lean();
      and.push({
        $or: [
          ...(doctor.user ? [{ participants: doctor.user }] : []),
          { reservation: { $in: visits.map((v) => v._id) } },
        ],
      });
    }
    if (input.q) and.push({ participants: { $in: await searchUserIds(input.q) } });
    const filter = and.length ? { $and: and } : {};

    const [rooms, total] = await Promise.all([
      CallRoom.find(filter)
        .sort({ startedAt: -1, _id: -1 })
        .skip((input.page - 1) * input.limit)
        .limit(input.limit)
        .populate({ path: "participants", select: USER_FIELDS })
        .populate({
          path: "reservation",
          select: "doctor patient date start end status sessionType",
          populate: [
            { path: "doctor", select: "firstName lastName" },
            { path: "patient", select: "givenName lastName" },
          ],
        })
        .lean(),
      CallRoom.countDocuments(filter),
    ]);
    const ids = rooms.map((r) => r._id);
    const [recordings, joined] = await Promise.all([
      CallRecording.aggregate([
        { $match: { room: { $in: ids } } },
        { $group: { _id: "$room", count: { $sum: 1 } } },
      ]),
      CallParticipant.aggregate([
        { $match: { room: { $in: ids }, joinedAt: { $exists: true } } },
        { $group: { _id: "$room", count: { $sum: 1 } } },
      ]),
    ]);
    const countOf = (rows: any[], id: unknown) =>
      rows.find((x) => String(x._id) === String(id))?.count || 0;

    res.status(200).json({
      message: "listCalls",
      data: rooms.map((room: any) => ({
        _id: room._id,
        callType: room.callType,
        source: room.source,
        status: room.status,
        startedAt: room.startedAt,
        connectedAt: room.connectedAt,
        endedAt: room.endedAt,
        duration: durationSeconds(room),
        participants: Array.isArray(room.participants) ? room.participants.filter(Boolean) : [],
        joined: countOf(joined, room._id),
        recordings: countOf(recordings, room._id),
        reservation: room.reservation || null,
      })),
      total,
      page: input.page,
      limit: input.limit,
    });
  },
);

// GET /admin/calls/:nodeId
export const getCall: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const room = await CallRoom.findById(nodeId)
      .populate({ path: "participants", select: USER_FIELDS })
      .populate({ path: "initiator", select: USER_FIELDS })
      .populate({ path: "endedBy", select: USER_FIELDS })
      .populate({
        path: "reservation",
        select: "doctor patient date start end status sessionType",
        populate: [
          { path: "doctor", select: "firstName lastName" },
          { path: "patient", select: "givenName lastName" },
        ],
      })
      .lean();
    if (!room) return next(new NotFoundError());
    const [participants, events, recordings] = await Promise.all([
      CallParticipant.find({ room: room._id })
        .populate({ path: "user", select: USER_FIELDS })
        .sort({ invitedAt: 1 })
        .lean(),
      CallEvent.find({ room: room._id })
        .populate({ path: "user", select: USER_FIELDS })
        .sort({ createdAt: 1 })
        .limit(500)
        .lean(),
      CallRecording.find({ room: room._id })
        .select("-filePath")
        .populate({ path: "startedBy", select: USER_FIELDS })
        .sort({ startedAt: 1 })
        .lean(),
    ]);
    res.status(200).json({
      message: "getCall",
      data: {
        data: {
          ...room,
          duration: durationSeconds(room),
          callParticipants: participants.map((p: any) => ({
            ...p,
            // seconds this person was in the room (joined -> left / ended)
            seconds:
              p.joinedAt
                ? Math.max(
                    0,
                    Math.round(
                      ((p.leftAt ? new Date(p.leftAt).getTime() : room.endedAt ? new Date(room.endedAt).getTime() : Date.now()) -
                        new Date(p.joinedAt).getTime()) /
                        1000,
                    ),
                  )
                : null,
          })),
          events,
          recordings,
        },
      },
    });
  },
);
