import * as mediasoup from "mediasoup";
import { Server as IOServer } from "socket.io";

import CallRoom, { CallType, ICallRoom } from "../../Models/CallRoom";
import CallParticipant, {
  ICallParticipant,
} from "../../Models/CallParticipant";
import CallEvent, { CallEventType } from "../../Models/CallEvent";
import CallRecording from "../../Models/CallRecording";
import User from "../../Models/User";
import Booking from "../../Models/Booking";
import DoctorProfile from "../../Models/DoctorProfile";
import UserIdentity from "../../Models/UserIdentity";
import Reservation from "../../Models/Reservation";
import { markReservationPresent } from "../reservationProgressService";
import AppError, {
  AccessError,
  BadInputError,
  NotFoundError,
} from "../../Lib/AppError";
import * as env from "../../Lib/Env";
import { getAppConfig } from "../../Lib/appConfig";
import { pageLimit } from "../../Lib/enums";

import { getNextWorker } from "./workerPool";
import { routerMediaCodecs, webRtcTransportOptions } from "./mediasoupConfig";
import { callRuntime, RuntimeRoom, RuntimeParticipant } from "./CallRuntime";
import {
  MediaTag,
  MuteKind,
  ProducerAppData,
  ProducerInfo,
  TransportAppData,
  TransportDirection,
} from "./types";
import * as recordingService from "./recordingService";

// Socket.io room name helpers - namespaced so a call room id and a user id
// (both 24-char Mongo ObjectId hex strings) can never collide.
export const callRoomChannel = (roomId: string) => `call:${roomId}`;
export const userChannel = (userId: string) => `user:${userId}`;

const RECORDABLE_TAGS: MediaTag[] = ["mic", "webcam"];

class CallService {
  private io: IOServer | null = null;
  private ringTimers: Map<string, NodeJS.Timeout> = new Map();

  attachIo(io: IOServer) {
    this.io = io;
  }

  private emitToRoom(roomId: string, event: string, payload: unknown) {
    this.io?.to(callRoomChannel(roomId)).emit(event, payload);
  }

  private emitToUser(userId: string, event: string, payload: unknown) {
    this.io?.to(userChannel(userId)).emit(event, payload);
  }

  private async logEvent(
    roomId: string,
    type: CallEventType,
    userId?: string,
    meta?: Record<string, unknown>,
  ) {
    try {
      await CallEvent.create({ room: roomId, user: userId, type, meta });
    } catch (err) {
      console.log("[call] failed to log call event", err);
    }
  }

  // Voice/video half of reservation in-progress tracking: fired the first
  // time a user joins a room that was opened by the reservation activation
  // sweep (room.reservation set). Marks whichever side (doctor/patient) the
  // joining user is - see Services/reservationProgressService.ts for what
  // "present" means and Services/reservationActivationService.ts for the
  // textChat/sipCall/inPerson equivalents.
  private async markReservationPartyPresent(room: ICallRoom, userId: string) {
    try {
      const reservation = await Reservation.findById(room.reservation).populate({
        path: "doctor",
        populate: { path: "user" },
      });
      if (!reservation) return;
      if (reservation.doctor?.user?._id?.toString() === userId) {
        await markReservationPresent(reservation._id, "doctor");
      } else if (reservation.user?.toString() === userId) {
        await markReservationPresent(reservation._id, "patient");
      }
    } catch (err) {
      console.log(
        `[call] failed to mark reservation presence for room ${room._id}:`,
        err,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Room lifecycle (DB-level, callable from REST controllers)
  // ---------------------------------------------------------------------

  async initiateCall({
    initiatorId,
    participantIds,
    callType,
    bookingId,
  }: {
    initiatorId: string;
    participantIds: string[];
    callType?: CallType;
    bookingId?: string;
  }): Promise<ICallRoom> {
    let source: "adhoc" | "booking" = "adhoc";
    let booking: InstanceType<typeof Booking> | null = null;
    // Note: the initiator is NOT auto-added to the call - e.g. an admin
    // starting a call for other users shouldn't be forced into it. If the
    // initiator wants to be part of the call, they must include their own
    // id in participantIds explicitly.
    let finalParticipantIds = Array.from(new Set(participantIds));
    const { callMaxParticipants, callRingTimeoutMs } = await getAppConfig();

    if (bookingId) {
      source = "booking";
      booking = await Booking.findById(bookingId);
      if (!booking) throw new NotFoundError("رزرو نوبت");
      const doctorProfile = await DoctorProfile.findById(booking.doctor).select(
        "user",
      );
      const doctorUserId = doctorProfile?.user?.toString();
      const patientUserId = booking.user.toString();
      if (initiatorId !== doctorUserId && initiatorId !== patientUserId) {
        throw new AccessError();
      }
      finalParticipantIds = Array.from(
        new Set([patientUserId, doctorUserId].filter(Boolean) as string[]),
      );
      if (!callType) {
        callType = booking.kind === "voiceCall" ? "voice" : "video";
      }
    }

    if (!callType) throw new BadInputError("نوع تماس مشخص نشده");
    if (finalParticipantIds.length < 2)
      throw new BadInputError("حداقل به یک نفر دیگر برای شروع تماس نیاز است");
    if (finalParticipantIds.length > callMaxParticipants)
      throw new AppError("ظرفیت این تماس تکمیل است", 400);

    const users = await User.find({ _id: { $in: finalParticipantIds } });
    if (users.length !== finalParticipantIds.length)
      throw new NotFoundError("کاربر");

    const room = await CallRoom.create({
      initiator: initiatorId,
      host: initiatorId,
      participants: finalParticipantIds,
      callType,
      source,
      booking: booking?._id,
      status: "ringing",
      maxParticipants: callMaxParticipants,
    });

    await CallParticipant.insertMany(
      finalParticipantIds.map((userId) => ({
        room: room._id,
        user: userId,
        role: userId === initiatorId ? "host" : "guest",
        status: "invited",
      })),
    );

    await this.logEvent(room._id.toString(), "created", initiatorId);

    const initiatorUser =
      users.find((u) => u._id.toString() === initiatorId) ||
      (await User.findById(initiatorId).select("phone username"));

    const userIds = users.map((u) => u._id.toString());

    for (const userId of userIds) {
      await this.logEvent(room._id.toString(), "invited", userId);
      this.emitToUser(userId, "call:incoming", {
        roomId: room._id.toString(),
        callType,
        initiator: initiatorId,
        initiatorPhone: initiatorUser?.phone,
        initiatorUsername: initiatorUser?.username,
      });
    }

    this.armRingTimeout(room._id.toString(), callRingTimeoutMs);

    return room;
  }

  private armRingTimeout(roomId: string, ringTimeoutMs: number) {
    const timer = setTimeout(() => {
      this.cancelIfUnanswered(roomId).catch((err) =>
        console.log("[call] ring timeout handling failed", err),
      );
    }, ringTimeoutMs);
    this.ringTimers.set(roomId, timer);
  }

  private clearRingTimeout(roomId: string) {
    const timer = this.ringTimers.get(roomId);
    if (timer) clearTimeout(timer);
    this.ringTimers.delete(roomId);
  }

  private async cancelIfUnanswered(roomId: string) {
    const room = await CallRoom.findById(roomId);
    if (!room || room.status === "ended" || room.status === "cancelled") return;

    const stillInvited = await CallParticipant.find({
      room: room._id,
      status: "invited",
    });
    if (stillInvited.length === 0) return; // everyone already answered one way or another

    if (room.status === "ringing") {
      // Nobody has joined at all yet - cancel the whole call, same as
      // before.
      room.status = "cancelled";
      room.endedAt = new Date();
      await room.save();
      await CallParticipant.updateMany(
        { room: room._id, status: "invited" },
        { status: "missed" },
      );
      await this.logEvent(roomId, "cancelled");
      this.emitToRoom(roomId, "call:cancelled", { roomId, reason: "timeout" });
      await this.destroyRuntimeRoom(roomId);
      return;
    }

    // The call is already under way for whoever did answer (e.g. the host,
    // who joins their own call immediately on creation) - give up on
    // whoever else never answered without touching the call for everyone
    // else still in it.
    for (const cp of stillInvited) {
      cp.status = "missed";
      await cp.save();
      const invitedUserId = cp.user.toString();
      await this.logEvent(roomId, "missed", invitedUserId);
      this.emitToUser(invitedUserId, "call:cancelled", {
        roomId,
        reason: "timeout",
      });
    }
  }

  async getCall(roomId: string, userId: string) {
    const room = await CallRoom.findOne({
      _id: roomId,
      participants: userId,
    })
      .populate("participants")
      .populate({ path: "callParticipants", populate: { path: "user" } });
    if (!room) throw new NotFoundError("تماس");
    const runtime = callRuntime.get(roomId);
    const connectedUserIds = runtime
      ? Array.from(runtime.participants.values())
          .filter((p) => p.socketIds.size > 0)
          .map((p) => p.userId)
      : [];
    // display names for the tiles (they used to read "user 63c2"): the
    // doctor profile's name for a doctor, else the verified identity
    const ids = (room.participants as unknown as { _id: unknown }[]).map(
      (p) => p?._id ?? p,
    );
    const [doctors, identities] = await Promise.all([
      DoctorProfile.find({ user: { $in: ids } }).select({
        user: 1,
        firstName: 1,
        lastName: 1,
      }),
      UserIdentity.find({ user: { $in: ids } }).select({
        user: 1,
        givenName: 1,
        lastName: 1,
      }),
    ]);
    const participantNames: Record<string, string> = {};
    for (const i of identities) {
      const name = `${i.givenName || ""} ${i.lastName || ""}`.trim();
      if (i.user && name) participantNames[i.user.toString()] = name;
    }
    for (const d of doctors) {
      const name = `${d.firstName || ""} ${d.lastName || ""}`.trim();
      if (d.user && name) participantNames[d.user.toString()] = name;
    }
    return { room, connectedUserIds, participantNames };
  }

  async listOngoing(userId: string) {
    return CallRoom.find({
      participants: userId,
      status: { $in: ["ringing", "active"] },
    })
      .populate("participants")
      .sort({ startedAt: -1 });
  }

  // Calls this user was invited to and hasn't answered yet, where the room
  // is still ringing (nobody cancelled/timed it out). Used to re-notify a
  // socket that just (re)connected - e.g. page refresh while the phone is
  // "ringing" - so it doesn't miss the incoming-call UI.
  async getPendingIncomingCalls(userId: string) {
    // Deliberately not just status: "ringing" - the room flips to "active"
    // the moment the FIRST participant joins (typically the host, who joins
    // their own call immediately on creation), well before other invited
    // participants have had a chance to answer. Whether a call is still
    // "ringing" for a given user is a per-participant question (their own
    // CallParticipant.status === "invited" below), not a room-wide one.
    const rooms = await CallRoom.find({
      participants: userId,
      status: { $in: ["ringing", "active"] },
    })
      .populate("initiator", "phone username")
      .sort({ startedAt: -1 });
    if (rooms.length === 0) return [];

    const participants = await CallParticipant.find({
      room: { $in: rooms.map((r) => r._id) },
      user: userId,
      status: "invited",
    });
    const invitedRoomIds = new Set(participants.map((p) => p.room.toString()));

    return rooms
      .filter((room) => invitedRoomIds.has(room._id.toString()))
      .map((room) => {
        const initiator = room.initiator as unknown as
          | { _id: { toString(): string }; phone?: string; username?: string }
          | undefined;
        return {
          roomId: room._id.toString(),
          callType: room.callType,
          initiator: initiator?._id?.toString(),
          initiatorPhone: initiator?.phone,
          initiatorUsername: initiator?.username,
        };
      });
  }

  async listHistory(
    userId: string,
    { page = 1, limit = pageLimit }: { page?: number; limit?: number } = {},
  ) {
    const query = {
      participants: userId,
      status: { $in: ["ended", "cancelled"] },
    };
    const [data, total] = await Promise.all([
      CallRoom.find(query)
        .populate("participants")
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      CallRoom.countDocuments(query),
    ]);
    return { data, total, page, limit };
  }

  async rejectCall({ roomId, userId }: { roomId: string; userId: string }) {
    const room = await CallRoom.findOne({ _id: roomId, participants: userId });
    if (!room) throw new NotFoundError("تماس");
    const participant = await CallParticipant.findOneAndUpdate(
      { room: room._id, user: userId },
      { status: "rejected" },
      { new: true },
    );
    await this.logEvent(roomId, "rejected", userId);
    this.emitToRoom(roomId, "call:participantRejected", { userId });

    if (room.status === "ringing") {
      const stillPending = await CallParticipant.exists({
        room: room._id,
        status: "invited",
      });
      const anyoneJoined = await CallParticipant.exists({
        room: room._id,
        status: "joined",
      });
      if (!stillPending && !anyoneJoined) {
        await this.cancelIfUnanswered(roomId);
      }
    }
    return participant;
  }

  // ---------------------------------------------------------------------
  // Runtime room / mediasoup plumbing
  // ---------------------------------------------------------------------

  private async getOrCreateRuntimeRoom(roomId: string): Promise<RuntimeRoom> {
    let runtime = callRuntime.get(roomId);
    if (runtime) return runtime;
    const worker = getNextWorker();
    const router = await worker.createRouter({
      mediaCodecs: routerMediaCodecs,
    });
    runtime = new RuntimeRoom(roomId, router);
    callRuntime.set(roomId, runtime);
    return runtime;
  }

  private async destroyRuntimeRoom(roomId: string) {
    const runtime = callRuntime.get(roomId);
    if (!runtime) return;
    await recordingService.stopAllRecordingsForRoom(roomId);
    await runtime.close();
    callRuntime.delete(roomId);
  }

  async joinCall({ roomId, userId }: { roomId: string; userId: string }) {
    const room = await CallRoom.findOne({ _id: roomId, participants: userId });
    if (!room) throw new NotFoundError("تماس");
    if (room.status === "ended" || room.status === "cancelled")
      throw new AppError("این تماس دیگر فعال نیست", 400);

    let cp = await CallParticipant.findOne({ room: room._id, user: userId });
    if (!cp) {
      // Shouldn't normally happen (participants is the source of invited
      // users), but guard anyway so a stray call:join can't crash.
      cp = await CallParticipant.create({
        room: room._id,
        user: userId,
        role: room.host?.toString() === userId ? "host" : "guest",
        status: "invited",
      });
    }
    if (cp.status === "kicked") throw new AccessError();

    const activeCount = await CallParticipant.countDocuments({
      room: room._id,
      status: "joined",
    });
    if (activeCount >= room.maxParticipants && cp.status !== "joined") {
      throw new AppError("ظرفیت این تماس تکمیل است", 400);
    }

    const runtime = await this.getOrCreateRuntimeRoom(roomId);
    const participant = runtime.getOrCreateParticipant(userId);

    const wasAlreadyJoined = cp.status === "joined";
    cp.status = "joined";
    if (!cp.joinedAt) cp.joinedAt = new Date();
    await cp.save();

    if (room.status !== "active") {
      room.status = "active";
      if (!room.connectedAt) room.connectedAt = new Date();
      await room.save();
    }

    // Only stop the ring timeout once nobody is left "ringing" - the room
    // flips to "active" the moment the FIRST participant joins (usually the
    // host, who joins their own call immediately on creation), but other
    // invited participants can still be legitimately ringing for a while
    // after that. Clearing this unconditionally on every join meant nobody
    // but the very first joiner was ever given up on for a missed call.
    const stillInvited = await CallParticipant.exists({
      room: room._id,
      status: "invited",
    });
    if (!stillInvited) this.clearRingTimeout(roomId);

    if (!wasAlreadyJoined) {
      await this.logEvent(roomId, "joined", userId);
      this.emitToRoom(roomId, "call:participantJoined", {
        userId,
        role: cp.role,
      });
      if (room.reservation) this.markReservationPartyPresent(room, userId);
    }

    const existingProducers: ProducerInfo[] = runtime
      .allProducers()
      .filter((p) => p.userId !== userId)
      .map((p) => ({
        producerId: p.producer.id,
        userId: p.userId,
        mediaTag: (p.producer.appData as ProducerAppData).mediaTag,
      }));

    return {
      rtpCapabilities: runtime.router.rtpCapabilities,
      role: cp.role,
      existingProducers,
    };
  }

  registerSocket({
    roomId,
    userId,
    socketId,
  }: {
    roomId: string;
    userId: string;
    socketId: string;
  }) {
    const runtime = callRuntime.get(roomId);
    if (!runtime) return;
    const participant = runtime.getOrCreateParticipant(userId);
    participant.socketIds.add(socketId);
  }

  async leaveCall({
    roomId,
    userId,
    socketId,
  }: {
    roomId: string;
    userId: string;
    socketId?: string;
  }) {
    const runtime = callRuntime.get(roomId);
    if (runtime) {
      const participant = runtime.participants.get(userId);
      if (participant) {
        if (socketId) participant.socketIds.delete(socketId);
        else participant.socketIds.clear();

        if (participant.socketIds.size === 0) {
          await participant.close();
          runtime.participants.delete(userId);

          await CallParticipant.findOneAndUpdate(
            { room: roomId, user: userId },
            { status: "left", leftAt: new Date() },
          );
          await this.logEvent(roomId, "left", userId);
          this.emitToRoom(roomId, "call:participantLeft", {
            userId,
            reason: "left",
          });
        }
      }

      if (runtime.isEmpty()) await this.handleEmptyRoom(roomId);
    }
  }

  // A booked visit's room must survive everyone stepping out: the doctor
  // joining first and dropping for a moment used to end the room for good,
  // so the patient could never join the visit they paid for. Such a room
  // only frees its media resources here and stays joinable; it is ended by
  // the reservation finalization sweep (endReservationCall) instead.
  private async handleEmptyRoom(roomId: string) {
    const room = await CallRoom.findById(roomId).select({ reservation: 1 });
    if (room?.reservation) {
      await this.destroyRuntimeRoom(roomId);
      return;
    }
    await this.finishCall(roomId, { reason: "empty" });
  }

  // Called when the reservation behind a booking room is finalized.
  async endReservationCall(roomId: string) {
    await this.finishCall(roomId, { reason: "reservationEnded" });
  }

  private async finishCall(
    roomId: string,
    { byUserId, reason }: { byUserId?: string; reason?: string } = {},
  ) {
    const room = await CallRoom.findById(roomId);
    if (!room || room.status === "ended" || room.status === "cancelled") return;
    await CallRoom.findByIdAndUpdate(roomId, {
      status: "ended",
      endedAt: new Date(),
      ...(byUserId && { endedBy: byUserId }),
    });
    await CallParticipant.updateMany(
      { room: room._id, status: { $in: ["invited", "joined"] } },
      { status: "left", leftAt: new Date() },
    );
    await this.logEvent(roomId, "ended", byUserId, { reason });
    this.emitToRoom(roomId, "call:ended", { roomId, reason });
    await this.destroyRuntimeRoom(roomId);
    this.clearRingTimeout(roomId);
  }

  async endCall({ roomId, byUserId }: { roomId: string; byUserId: string }) {
    const room = await CallRoom.findById(roomId);
    if (!room) throw new NotFoundError("تماس");
    if (room.host?.toString() !== byUserId) throw new AccessError();
    if (room.status === "ended" || room.status === "cancelled") return room;
    await this.finishCall(roomId, { byUserId, reason: "endedByHost" });
    return CallRoom.findById(roomId);
  }

  async kickParticipant({
    roomId,
    targetUserId,
    byUserId,
  }: {
    roomId: string;
    targetUserId: string;
    byUserId: string;
  }) {
    const room = await CallRoom.findById(roomId);
    if (!room) throw new NotFoundError("تماس");
    if (room.host?.toString() !== byUserId) throw new AccessError();
    if (targetUserId === byUserId)
      throw new BadInputError("میزبان نمیتواند خودش را حذف کند");

    const runtime = callRuntime.get(roomId);
    const participant = runtime?.participants.get(targetUserId);
    const socketIds = participant ? Array.from(participant.socketIds) : [];
    if (participant) {
      await participant.close();
      runtime?.participants.delete(targetUserId);
    }

    for (const socketId of socketIds) {
      this.io?.in(socketId).socketsLeave(callRoomChannel(roomId));
    }

    await CallParticipant.findOneAndUpdate(
      { room: roomId, user: targetUserId },
      {
        status: "kicked",
        leftAt: new Date(),
        kickedBy: byUserId,
      },
    );
    await this.logEvent(roomId, "kicked", targetUserId, { byUserId });
    this.emitToUser(targetUserId, "call:kicked", { roomId });
    this.emitToRoom(roomId, "call:participantLeft", {
      userId: targetUserId,
      reason: "kicked",
    });

    if (runtime?.isEmpty()) await this.handleEmptyRoom(roomId);
  }

  // ---------------------------------------------------------------------
  // Mute / video / screen-share bookkeeping
  // ---------------------------------------------------------------------

  private findParticipantProducersByTag(
    participant: RuntimeParticipant,
    tag: MediaTag,
  ): mediasoup.types.Producer<ProducerAppData>[] {
    return Array.from(participant.producers.values()).filter(
      (p) => p.appData.mediaTag === tag,
    );
  }

  async setSelfMute({
    roomId,
    userId,
    kind,
    muted,
  }: {
    roomId: string;
    userId: string;
    kind: MuteKind;
    muted: boolean;
  }) {
    const cp = await CallParticipant.findOne({ room: roomId, user: userId });
    if (!cp) throw new NotFoundError("شرکت کننده");
    if (cp.forceMuted && kind === "audio" && !muted)
      throw new AppError(
        "میزبان تماس شما را بی صدا کرده و امکان روشن کردن میکروفون وجود ندارد",
        400,
      );

    const runtime = callRuntime.get(roomId);
    const participant = runtime?.participants.get(userId);
    const tag: MediaTag = kind === "audio" ? "mic" : "webcam";
    if (participant) {
      for (const producer of this.findParticipantProducersByTag(
        participant,
        tag,
      )) {
        if (muted) await producer.pause();
        else await producer.resume();
      }
    }

    if (kind === "audio") cp.audioMuted = muted;
    else cp.videoMuted = muted;
    await cp.save();

    await this.logEvent(
      roomId,
      muted
        ? kind === "audio"
          ? "muted"
          : "videoOff"
        : kind === "audio"
          ? "unmuted"
          : "videoOn",
      userId,
    );
    this.emitToRoom(roomId, "call:participantMuteChanged", {
      userId,
      kind,
      muted,
      forced: false,
    });
    return cp;
  }

  async forceMuteParticipant({
    roomId,
    targetUserId,
    byUserId,
    kind,
    muted,
  }: {
    roomId: string;
    targetUserId: string;
    byUserId: string;
    kind: MuteKind;
    muted: boolean;
  }) {
    const room = await CallRoom.findById(roomId);
    if (!room) throw new NotFoundError("تماس");
    if (room.host?.toString() !== byUserId) throw new AccessError();

    const cp = await CallParticipant.findOne({
      room: roomId,
      user: targetUserId,
    });
    if (!cp) throw new NotFoundError("شرکت کننده");

    const runtime = callRuntime.get(roomId);
    const participant = runtime?.participants.get(targetUserId);
    const tag: MediaTag = kind === "audio" ? "mic" : "webcam";
    if (participant) {
      for (const producer of this.findParticipantProducersByTag(
        participant,
        tag,
      )) {
        if (muted) await producer.pause();
        else await producer.resume();
      }
    }

    if (kind === "audio") {
      cp.audioMuted = muted;
      cp.forceMuted = muted;
    } else {
      cp.videoMuted = muted;
    }
    await cp.save();

    await this.logEvent(roomId, muted ? "muted" : "unmuted", targetUserId, {
      byUserId,
      forced: true,
    });
    this.emitToRoom(roomId, "call:participantMuteChanged", {
      userId: targetUserId,
      kind,
      muted,
      forced: true,
    });
    this.emitToUser(targetUserId, "call:youWereMuted", { kind, muted });
    return cp;
  }

  // ---------------------------------------------------------------------
  // Mediasoup signaling primitives (used directly by the socket layer)
  // ---------------------------------------------------------------------

  async getRtpCapabilities(roomId: string) {
    const runtime = await this.getOrCreateRuntimeRoom(roomId);
    return runtime.router.rtpCapabilities;
  }

  async createTransport({
    roomId,
    userId,
    direction,
  }: {
    roomId: string;
    userId: string;
    direction: TransportDirection;
  }) {
    const runtime = callRuntime.get(roomId);
    if (!runtime) throw new AppError("ابتدا باید وارد تماس شوید", 400);
    const participant = runtime.getOrCreateParticipant(userId);

    const appData: TransportAppData = { userId, direction };
    const transport = await runtime.router.createWebRtcTransport({
      ...webRtcTransportOptions,
      appData,
    });

    if (direction === "send")
      participant.sendTransports.set(transport.id, transport);
    else participant.recvTransports.set(transport.id, transport);

    transport.observer.once("close", () => {
      participant.sendTransports.delete(transport.id);
      participant.recvTransports.delete(transport.id);
    });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  private findTransport(
    runtime: RuntimeRoom,
    userId: string,
    transportId: string,
  ) {
    const participant = runtime.participants.get(userId);
    if (!participant) return undefined;
    return (
      participant.sendTransports.get(transportId) ||
      participant.recvTransports.get(transportId)
    );
  }

  async connectTransport({
    roomId,
    userId,
    transportId,
    dtlsParameters,
  }: {
    roomId: string;
    userId: string;
    transportId: string;
    dtlsParameters: mediasoup.types.DtlsParameters;
  }) {
    const runtime = callRuntime.get(roomId);
    if (!runtime) throw new AppError("تماس فعالی یافت نشد", 400);
    const transport = this.findTransport(runtime, userId, transportId);
    if (!transport) throw new NotFoundError("تراسپورت");
    await transport.connect({ dtlsParameters });
  }

  async produce({
    roomId,
    userId,
    transportId,
    kind,
    rtpParameters,
    mediaTag,
  }: {
    roomId: string;
    userId: string;
    transportId: string;
    kind: mediasoup.types.MediaKind;
    rtpParameters: mediasoup.types.RtpParameters;
    mediaTag: MediaTag;
  }) {
    const runtime = callRuntime.get(roomId);
    if (!runtime) throw new AppError("تماس فعالی یافت نشد", 400);
    const participant = runtime.participants.get(userId);
    if (!participant) throw new AppError("ابتدا باید وارد تماس شوید", 400);
    const transport = participant.sendTransports.get(transportId);
    if (!transport) throw new NotFoundError("تراسپورت");

    const appData: ProducerAppData = { userId, mediaTag };
    const producer = await transport.produce({ kind, rtpParameters, appData });
    participant.producers.set(producer.id, producer);

    producer.observer.once("close", () => {
      participant.producers.delete(producer.id);
    });

    if (mediaTag === "screenVideo" || mediaTag === "screenAudio") {
      await CallParticipant.findOneAndUpdate(
        { room: roomId, user: userId },
        { screenSharing: true },
      );
      await this.logEvent(roomId, "screenShareStarted", userId);
    }

    this.emitToRoom(roomId, "call:newProducer", {
      producerId: producer.id,
      userId,
      mediaTag,
    } satisfies ProducerInfo);

    // If recording is currently on for this room, and this is a recordable
    // track, start capturing it too (covers late joiners / cams turned on
    // after recording started).
    const room = await CallRoom.findById(roomId).select("recordingEnabled");
    if (room?.recordingEnabled && RECORDABLE_TAGS.includes(mediaTag)) {
      await recordingService
        .recordSingleProducer({
          roomId,
          router: runtime.router,
          userId,
          producer,
          startedBy: userId,
        })
        .catch((err) =>
          console.log("[call] failed to start late recording", err),
        );
    }

    return { id: producer.id };
  }

  async closeProducer({
    roomId,
    userId,
    producerId,
  }: {
    roomId: string;
    userId: string;
    producerId: string;
  }) {
    const runtime = callRuntime.get(roomId);
    const participant = runtime?.participants.get(userId);
    const producer = participant?.producers.get(producerId);
    if (!producer) return;
    const mediaTag = (producer.appData as ProducerAppData).mediaTag;
    producer.close();
    participant?.producers.delete(producerId);

    if (mediaTag === "screenVideo" || mediaTag === "screenAudio") {
      await CallParticipant.findOneAndUpdate(
        { room: roomId, user: userId },
        { screenSharing: false },
      );
      await this.logEvent(roomId, "screenShareStopped", userId);
    }

    this.emitToRoom(roomId, "call:producerClosed", { producerId, userId });
  }

  async consume({
    roomId,
    userId,
    transportId,
    producerId,
    rtpCapabilities,
  }: {
    roomId: string;
    userId: string;
    transportId: string;
    producerId: string;
    rtpCapabilities: mediasoup.types.RtpCapabilities;
  }) {
    const runtime = callRuntime.get(roomId);
    if (!runtime) throw new AppError("تماس فعالی یافت نشد", 400);
    if (!runtime.router.canConsume({ producerId, rtpCapabilities }))
      throw new AppError("امکان دریافت این جریان تصویری وجود ندارد", 400);

    const participant = runtime.participants.get(userId);
    if (!participant) throw new AppError("ابتدا باید وارد تماس شوید", 400);
    const transport = participant.recvTransports.get(transportId);
    if (!transport) throw new NotFoundError("تراسپورت");

    const producerOwner = Array.from(runtime.participants.values()).find((p) =>
      p.producers.has(producerId),
    );
    const sourceProducer = producerOwner?.producers.get(producerId);

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });
    participant.consumers.set(consumer.id, consumer);
    consumer.observer.once("close", () => {
      participant.consumers.delete(consumer.id);
    });

    return {
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerId,
      producerUserId: producerOwner?.userId,
      mediaTag: sourceProducer
        ? (sourceProducer.appData as ProducerAppData).mediaTag
        : undefined,
    };
  }

  async resumeConsumer({
    roomId,
    userId,
    consumerId,
  }: {
    roomId: string;
    userId: string;
    consumerId: string;
  }) {
    const runtime = callRuntime.get(roomId);
    const participant = runtime?.participants.get(userId);
    const consumer = participant?.consumers.get(consumerId);
    if (!consumer) throw new NotFoundError("مصرف کننده رسانه");
    await consumer.resume();
  }

  // ---------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------

  async startRecording({
    roomId,
    byUserId,
  }: {
    roomId: string;
    byUserId: string;
  }) {
    const room = await CallRoom.findById(roomId);
    if (!room) throw new NotFoundError("تماس");
    if (room.host?.toString() !== byUserId) throw new AccessError();
    if (room.status !== "active")
      throw new AppError("تماس فعالی برای ضبط وجود ندارد", 400);

    const runtime = callRuntime.get(roomId);
    if (!runtime) throw new AppError("تماس فعالی برای ضبط وجود ندارد", 400);

    room.recordingEnabled = true;
    await room.save();

    for (const { userId, producer } of runtime.allProducers()) {
      const mediaTag = (producer.appData as ProducerAppData).mediaTag;
      if (!RECORDABLE_TAGS.includes(mediaTag)) continue;
      await recordingService
        .recordSingleProducer({
          roomId,
          router: runtime.router,
          userId,
          producer,
          startedBy: byUserId,
        })
        .catch((err) => console.log("[call] failed to start recording", err));
    }

    await this.logEvent(roomId, "recordingStarted", byUserId);
    this.emitToRoom(roomId, "call:recordingStarted", { roomId });
  }

  async stopRecording({
    roomId,
    byUserId,
  }: {
    roomId: string;
    byUserId: string;
  }) {
    const room = await CallRoom.findById(roomId);
    if (!room) throw new NotFoundError("تماس");
    if (room.host?.toString() !== byUserId) throw new AccessError();

    await recordingService.stopAllRecordingsForRoom(roomId);
    room.recordingEnabled = false;
    await room.save();

    await this.logEvent(roomId, "recordingStopped", byUserId);
    this.emitToRoom(roomId, "call:recordingStopped", { roomId });
  }

  async listRecordings(roomId: string, userId: string) {
    const room = await CallRoom.findOne({ _id: roomId, participants: userId });
    if (!room) throw new NotFoundError("تماس");
    return CallRecording.find({ room: roomId }).populate({
      path: "participant",
      populate: { path: "user" },
    });
  }
}

export const callService = new CallService();
export default callService;
