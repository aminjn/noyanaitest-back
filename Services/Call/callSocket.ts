import { Server as IOServer, Socket, ExtendedError } from "socket.io";
import * as cookie from "cookie";
import * as mediasoup from "mediasoup";

import User from "../../Models/User";
import { extractDataFromCookie } from "../../Controllers/authController";
import AppError from "../../Lib/AppError";

import { callService, callRoomChannel, userChannel } from "./CallService";
import { MediaTag, MuteKind, TransportDirection } from "./types";

type Ack = (
  response: { ok: true; data: unknown } | { ok: false; error: string },
) => void;

// Every handler below follows the same shape: do the work, ack success with
// the return value, or ack a Persian error message on failure (mirroring
// the AppError messages the REST controllers already use) instead of
// throwing across the socket boundary.
const respond = async (ack: Ack | undefined, work: () => Promise<unknown>) => {
  try {
    const data = await work();
    ack?.({ ok: true, data });
  } catch (err) {
    if (!(err instanceof AppError))
      console.log("[call socket] handler error", err);
    const message =
      err instanceof AppError ? err.message : "خطای غیرمنتظره ای رخ داد";
    ack?.({ ok: false, error: message });
  }
};

// Cookie/JWT based auth, same mechanism authController.protect uses for
// REST requests - deliberately hard-fails (no anonymous calling).
const useCallAuth = async (
  socket: Socket,
  next: (err?: ExtendedError) => void,
) => {
  try {
    const rawCookies = socket.handshake.headers.cookie;
    const parsed = rawCookies ? cookie.parse(rawCookies) : {};
    const token = parsed.token;
    if (!token) return next(new Error("Unauthorized"));
    const decoded = await extractDataFromCookie({
      cookie: token,
      name: "token",
    });
    if (!decoded) return next(new Error("Unauthorized"));
    const user = await User.findById(decoded.id);
    if (!user) return next(new Error("Unauthorized"));
    socket.user = user;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
};

export const initCallSocket = (io: IOServer): void => {
  io.use(useCallAuth);

  io.on("connection", (socket: Socket) => {
    const user = socket.user;
    if (!user) {
      socket.disconnect(true);
      return;
    }
    const userId = user._id.toString();
    socket.join(userChannel(userId));

    // Re-surfacing "you have a call ringing" on (re)connect (e.g. after a
    // page refresh while the phone is still ringing) is deliberately
    // client-pulled rather than pushed automatically here. A push fired
    // from this connection handler can race the client's own
    // "call:incoming" listener - which only gets attached once whatever
    // component owns it has mounted/run its effect - and get silently
    // dropped if the listener isn't there yet the instant we'd emit it.
    // The client asks for this explicitly (see "call:checkPending" below)
    // right after it's actually listening, which makes it race-free.
    socket.on(
      "call:checkPending",
      (_data: unknown, ack?: Ack) =>
        void respond(ack, async () => {
          const calls = await callService.getPendingIncomingCalls(userId);
          for (const call of calls) socket.emit("call:incoming", call);
          return calls;
        }),
    );

    const joinedRooms: Set<string> = new Set();

    socket.on(
      "call:join",
      (data: { roomId: string }, ack?: Ack) =>
        void respond(ack, async () => {
          const result = await callService.joinCall({
            roomId: data.roomId,
            userId,
          });
          socket.join(callRoomChannel(data.roomId));
          callService.registerSocket({
            roomId: data.roomId,
            userId,
            socketId: socket.id,
          });
          joinedRooms.add(data.roomId);
          return result;
        }),
    );

    socket.on(
      "call:leave",
      (data: { roomId: string }, ack?: Ack) =>
        void respond(ack, async () => {
          await callService.leaveCall({
            roomId: data.roomId,
            userId,
            socketId: socket.id,
          });
          socket.leave(callRoomChannel(data.roomId));
          joinedRooms.delete(data.roomId);
          return { left: true };
        }),
    );

    socket.on(
      "call:reject",
      (data: { roomId: string }, ack?: Ack) =>
        void respond(ack, () =>
          callService.rejectCall({ roomId: data.roomId, userId }),
        ),
    );

    socket.on(
      "call:getRtpCapabilities",
      (data: { roomId: string }, ack?: Ack) =>
        void respond(ack, () => callService.getRtpCapabilities(data.roomId)),
    );

    socket.on(
      "call:createTransport",
      (data: { roomId: string; direction: TransportDirection }, ack?: Ack) =>
        void respond(ack, () =>
          callService.createTransport({
            roomId: data.roomId,
            userId,
            direction: data.direction,
          }),
        ),
    );

    socket.on(
      "call:connectTransport",
      (
        data: {
          roomId: string;
          transportId: string;
          dtlsParameters: mediasoup.types.DtlsParameters;
        },
        ack?: Ack,
      ) =>
        void respond(ack, () =>
          callService.connectTransport({
            roomId: data.roomId,
            userId,
            transportId: data.transportId,
            dtlsParameters: data.dtlsParameters,
          }),
        ),
    );

    socket.on(
      "call:produce",
      (
        data: {
          roomId: string;
          transportId: string;
          kind: mediasoup.types.MediaKind;
          rtpParameters: mediasoup.types.RtpParameters;
          mediaTag: MediaTag;
        },
        ack?: Ack,
      ) =>
        void respond(ack, () =>
          callService.produce({
            roomId: data.roomId,
            userId,
            transportId: data.transportId,
            kind: data.kind,
            rtpParameters: data.rtpParameters,
            mediaTag: data.mediaTag,
          }),
        ),
    );

    socket.on(
      "call:closeProducer",
      (data: { roomId: string; producerId: string }, ack?: Ack) =>
        void respond(ack, () =>
          callService.closeProducer({
            roomId: data.roomId,
            userId,
            producerId: data.producerId,
          }),
        ),
    );

    socket.on(
      "call:consume",
      (
        data: {
          roomId: string;
          transportId: string;
          producerId: string;
          rtpCapabilities: mediasoup.types.RtpCapabilities;
        },
        ack?: Ack,
      ) =>
        void respond(ack, () =>
          callService.consume({
            roomId: data.roomId,
            userId,
            transportId: data.transportId,
            producerId: data.producerId,
            rtpCapabilities: data.rtpCapabilities,
          }),
        ),
    );

    socket.on(
      "call:resumeConsumer",
      (data: { roomId: string; consumerId: string }, ack?: Ack) =>
        void respond(ack, () =>
          callService.resumeConsumer({
            roomId: data.roomId,
            userId,
            consumerId: data.consumerId,
          }),
        ),
    );

    socket.on(
      "call:setMute",
      (data: { roomId: string; kind: MuteKind; muted: boolean }, ack?: Ack) =>
        void respond(ack, () =>
          callService.setSelfMute({
            roomId: data.roomId,
            userId,
            kind: data.kind,
            muted: data.muted,
          }),
        ),
    );

    socket.on(
      "call:kick",
      (data: { roomId: string; targetUserId: string }, ack?: Ack) =>
        void respond(ack, () =>
          callService.kickParticipant({
            roomId: data.roomId,
            targetUserId: data.targetUserId,
            byUserId: userId,
          }),
        ),
    );

    socket.on(
      "call:muteParticipant",
      (
        data: {
          roomId: string;
          targetUserId: string;
          kind: MuteKind;
          muted: boolean;
        },
        ack?: Ack,
      ) =>
        void respond(ack, () =>
          callService.forceMuteParticipant({
            roomId: data.roomId,
            targetUserId: data.targetUserId,
            byUserId: userId,
            kind: data.kind,
            muted: data.muted,
          }),
        ),
    );

    socket.on(
      "call:startRecording",
      (data: { roomId: string }, ack?: Ack) =>
        void respond(ack, () =>
          callService.startRecording({ roomId: data.roomId, byUserId: userId }),
        ),
    );

    socket.on(
      "call:stopRecording",
      (data: { roomId: string }, ack?: Ack) =>
        void respond(ack, () =>
          callService.stopRecording({ roomId: data.roomId, byUserId: userId }),
        ),
    );

    socket.on("disconnect", () => {
      for (const roomId of joinedRooms) {
        callService
          .leaveCall({ roomId, userId, socketId: socket.id })
          .catch((err) =>
            console.log("[call socket] cleanup on disconnect failed", err),
          );
      }
    });
  });
};
