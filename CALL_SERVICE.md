# Call Service

Voice/video calling for NoyanAI: WebRTC media via [mediasoup](https://mediasoup.org) (SFU), signaling via Socket.IO, control-plane (create/list/end/moderate/record) via REST. Ad-hoc calls between any two+ users, or calls linked to a `Booking`. Group calls, screen share, host moderation (kick/force-mute), and server-side recording are all supported.

This document covers how it's built on the backend and, more importantly, how to drive it from a client (web/mobile).

---

## 1. Architecture

```
Client                          Server
------                          ------
REST  ───────────────────────▶  Controllers/callController.ts
 (create/list/end/kick/mute/       │
  recording/history)               ▼
                                 Services/Call/CallService.ts  ◀── single source of truth
                                    │                 │
Socket.IO ─────────────────────▶  callSocket.ts        │
 (join/leave/produce/consume/      │                 │
  mute/kick/recording)             ▼                 ▼
                                 CallRuntime.ts    Mongo models
                                 (in-memory:       (CallRoom, CallParticipant,
                                  mediasoup         CallRecording, CallEvent)
                                  Router/Transport/
                                  Producer/Consumer)
                                    │
                                    ▼
                                 mediasoup Worker pool (workerPool.ts)
                                    │
                                    ▼
                                 recordingService.ts ──▶ ffmpeg ──▶ CallRecordings/*.webm|mp4
```

Two kinds of state are kept, deliberately separate:

- **Durable state** (Mongo): who's invited, who joined/left/was kicked, mute flags, recording metadata, an audit log. Survives restarts, is what the REST API reads/writes.
- **Live state** (in-process memory, `CallRuntime.ts`): the actual mediasoup `Router`/`Transport`/`Producer`/`Consumer` objects for calls currently in progress. Cannot be persisted (they're live media pipelines), and only exists on whichever server process is handling that call.

**Important constraint:** this only works as a single Node process. If the backend is ever scaled horizontally, calls need sticky routing (all signaling for a given room must land on the process that owns its mediasoup `Router`), or a proper multi-node SFU setup (mediasoup supports piping between routers on different workers/hosts, but that's not implemented here).

### File map (`Services/Call/`)

| File | Responsibility |
|---|---|
| `mediasoupConfig.ts` | Codecs (opus, VP8, H264), WebRTC/PlainTransport options |
| `workerPool.ts` | Spins up one mediasoup `Worker` per CPU core at boot, hands out `Router`s round-robin, each worker gets its own UDP/TCP port slice |
| `types.ts` | Shared types: `MediaTag`, `ProducerAppData`, `TransportAppData`, `MuteKind`, `ProducerInfo` |
| `CallRuntime.ts` | In-memory registry of live rooms/participants/transports/producers/consumers |
| `CallService.ts` | **The service.** All business logic - call lifecycle, mediasoup signaling primitives, mute/kick/recording. Called by both REST controllers and the socket layer |
| `recordingService.ts` | PlainTransport + ffmpeg based recording, one file per recorded track |
| `callSocket.ts` | Socket.IO auth + event handlers, thin wrappers around `CallService` |
| `index.ts` | `initCallService(server)` - boot entrypoint, wires everything together and is what `server.ts` calls |

The old `socket/` folder (mediasoup demo) is untouched and unused - do not import from it.

---

## 2. Data model

### CallRoom (Mongo model name: `VoiceRoom`)

| Field | Type | Notes |
|---|---|---|
| `initiator`, `host` | `User` ref | Host is who can moderate (kick/force-mute/end/record) - currently always the initiator |
| `participants` | `User[]` | Everyone invited to the room (not necessarily currently connected) |
| `callType` | `"voice" \| "video"` | |
| `source` | `"adhoc" \| "booking"` | |
| `booking` | `Booking` ref | Set when `source === "booking"` |
| `status` | `"ringing" \| "active" \| "ended" \| "cancelled"` | See state machine below |
| `startedAt`, `connectedAt`, `endedAt`, `endedBy` | | |
| `recordingEnabled` | `boolean` | |
| `maxParticipants` | `number` | Default 8, configurable via `CALL_MAX_PARTICIPANTS` env |

**Status state machine:**

```
ringing ──(someone joins)──▶ active ──(room empties / host ends)──▶ ended
   │
   └──(ring timeout / everyone rejects, nobody joined)──▶ cancelled
```

### CallParticipant

One row per (room, user). This is the source of truth for "who's in this call and what state are they in" - richer than just the `CallRoom.participants` array.

| Field | Notes |
|---|---|
| `room`, `user` | |
| `role` | `"host" \| "guest"` |
| `status` | `"invited" \| "joined" \| "left" \| "kicked" \| "rejected" \| "missed"` |
| `invitedAt`, `joinedAt`, `leftAt` | |
| `audioMuted`, `videoMuted` | Current mute state (self or forced) |
| `forceMuted` | `true` if the host muted them - client must not let them self-unmute audio while this is set |
| `screenSharing` | |
| `kickedBy` | |

### CallRecording

One row per recorded track (not one per call - a video call with two participants recording produces two `kind: "participant"` rows, one per person's mic+cam producer; a screen share adds a `kind: "screen"` row).

| Field | Notes |
|---|---|
| `room`, `participant`, `startedBy` | |
| `kind` | `"participant" \| "screen"` |
| `filePath` | Relative to backend `process.cwd()`, under `CallRecordings/` |
| `format` | `"webm"` (opus / VP8) or `"mp4"` (H264 video) |
| `status` | `"recording" \| "processing" \| "ready" \| "failed"` |
| `error` | Populated when `status === "failed"` |

### CallEvent

Append-only audit log (`created`, `invited`, `joined`, `left`, `kicked`, `muted`, `screenShareStarted`, `recordingStarted`, `ended`, ...). Not exposed via a dedicated endpoint yet, but useful for support/dispute resolution directly from Mongo.

---

## 3. REST API

Base path: `/api/v1/call`. All routes require the normal session cookie (`authController.protect`) - same auth as the rest of the API. Body is sent as `multipart/form-data` (matches the rest of this API - use `upload.none()` semantics, i.e. plain fields, no files) for POST/PUT.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/` | `{ participantIds: string[], callType: "voice"\|"video" }` | Start an ad-hoc call. You don't need to include yourself in `participantIds`. Returns `201` + the `CallRoom`. Pushes `call:incoming` to every invitee's personal channel |
| POST | `/booking/:bookingId` | `{ callType?: "voice"\|"video" }` | Start a call linked to a booking. Caller must be the booking's patient or doctor. Participants are derived from the booking; `callType` derived from `booking.kind` if omitted |
| GET | `/` | - | Your calls currently `ringing` or `active` |
| GET | `/history?page=&limit=` | - | Your `ended`/`cancelled` calls, paginated |
| GET | `/:nodeId` | - | `{ room, connectedUserIds }` - `connectedUserIds` reflects live socket state, not just DB status |
| POST | `/:nodeId/answer` | - | Optional UX nicety - acknowledges the ring. Actually joining media happens over the socket (`call:join`) |
| POST | `/:nodeId/reject` | - | Decline before joining |
| PUT | `/:nodeId/leave` | - | Leave (works even if your socket already dropped) |
| DELETE | `/:nodeId` | - | End the call for everyone. **Host only** |
| POST | `/:nodeId/kick` | `{ targetUserId }` | **Host only** |
| POST | `/:nodeId/mute` | `{ targetUserId, kind: "audio"\|"video", muted: boolean }` | Force-mute. **Host only** |
| POST | `/:nodeId/recording/start` | - | **Host only**. Requires `ffmpeg` on the server |
| POST | `/:nodeId/recording/stop` | - | **Host only** |
| GET | `/:nodeId/recordings` | - | List `CallRecording` docs for the room |

All responses follow the existing API convention: `{ message: string, data?: ... }`. Errors are the same `AppError` shape (`{ status, message }`) with Persian messages, same as every other endpoint.

---

## 4. Socket.IO signaling

- **Path:** `/api/socket.io` (same socket.io server the app already exposes, no separate namespace)
- **Auth:** the `token` auth cookie (same JWT as REST). Connect with `withCredentials: true` so the browser sends it. No cookie/invalid token ⇒ the server refuses the connection with `Unauthorized`.
- Every emitted event that expects a response takes an **ack callback** as its last argument:
  `ack({ ok: true, data }) | ack({ ok: false, error: "پیام فارسی" })`.
- On connect you're automatically joined to a personal channel (`user:<yourUserId>`) - this is how `call:incoming` reaches you without joining a specific call room first.

### Events you emit

| Event | Payload | Ack `data` |
|---|---|---|
| `call:join` | `{ roomId }` | `{ rtpCapabilities, role, existingProducers: [{producerId, userId, mediaTag}] }` |
| `call:leave` | `{ roomId }` | `{ left: true }` |
| `call:reject` | `{ roomId }` | updated `CallParticipant` |
| `call:getRtpCapabilities` | `{ roomId }` | mediasoup `RtpCapabilities` |
| `call:createTransport` | `{ roomId, direction: "send"\|"recv" }` | `{ id, iceParameters, iceCandidates, dtlsParameters }` |
| `call:connectTransport` | `{ roomId, transportId, dtlsParameters }` | - |
| `call:produce` | `{ roomId, transportId, kind: "audio"\|"video", rtpParameters, mediaTag }` | `{ id }` (producer id) |
| `call:closeProducer` | `{ roomId, producerId }` | - |
| `call:consume` | `{ roomId, transportId, producerId, rtpCapabilities }` | `{ id, kind, rtpParameters, producerId, producerUserId, mediaTag }` |
| `call:resumeConsumer` | `{ roomId, consumerId }` | - |
| `call:setMute` | `{ roomId, kind: "audio"\|"video", muted }` | updated `CallParticipant` |
| `call:kick` | `{ roomId, targetUserId }` | - (host only) |
| `call:muteParticipant` | `{ roomId, targetUserId, kind, muted }` | updated `CallParticipant` (host only) |
| `call:startRecording` | `{ roomId }` | - (host only) |
| `call:stopRecording` | `{ roomId }` | - (host only) |

`mediaTag` is one of `"mic" | "webcam" | "screenVideo" | "screenAudio"` - it's how peers know what a given producer actually is (there's no other reliable way to tell "this video track is a webcam" from "this video track is a screen share").

### Events the server pushes to you (no ack)

Broadcast to everyone in the call room, unless noted otherwise:

| Event | Payload | When |
|---|---|---|
| `call:incoming` *(personal channel)* | `{ roomId, callType, initiator, initiatorPhone, initiatorUsername }` | You've been invited to a new call |
| `call:participantJoined` | `{ userId, role }` | Someone's media connected |
| `call:participantLeft` | `{ userId, reason: "left" \| "kicked" }` | |
| `call:participantRejected` | `{ userId }` | |
| `call:newProducer` | `{ producerId, userId, mediaTag }` | Someone started sending a track (mic/cam/screen) - consume it |
| `call:producerClosed` | `{ producerId, userId }` | Stop rendering that track |
| `call:participantMuteChanged` | `{ userId, kind, muted, forced }` | `forced: true` means the host did it |
| `call:youWereMuted` *(personal channel)* | `{ kind, muted }` | The host force-muted **you** specifically |
| `call:kicked` *(personal channel)* | `{ roomId }` | You were removed - tear down your side immediately |
| `call:cancelled` | `{ roomId, reason }` | Ring timed out / everyone declined before anyone joined |
| `call:ended` | `{ roomId, reason }` | Call is over for everyone - tear down |
| `call:recordingStarted` / `call:recordingStopped` | `{ roomId }` | |

---

## 5. Client integration walkthrough

Uses [`mediasoup-client`](https://www.npmjs.com/package/mediasoup-client) (the standard browser-side counterpart to the server `mediasoup` package) and `socket.io-client`.

```bash
npm install mediasoup-client socket.io-client
```

### 5.1 Connect the socket

```ts
import { io, Socket } from "socket.io-client";

const socket: Socket = io(API_ORIGIN, {
  path: "/api/socket.io",
  withCredentials: true, // sends the auth cookie
});

socket.on("connect_error", (err) => {
  // fires immediately if the cookie is missing/expired
  console.error("call socket auth failed", err.message);
});

// Promise wrapper around the ack pattern used by every call:* event
function emitAck<T = any>(event: string, payload: object): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (res: { ok: boolean; data?: T; error?: string }) => {
      if (res.ok) resolve(res.data as T);
      else reject(new Error(res.error));
    });
  });
}
```

### 5.2 Start or receive a call

```ts
// Starting one:
const { data: room } = await fetch("/api/v1/call", {
  method: "POST",
  credentials: "include",
  body: new URLSearchParams({
    "participantIds[]": otherUserId,
    callType: "video",
  }),
}).then((r) => r.json());

// Receiving one - fires on your personal channel as soon as you're connected,
// even before you've joined the specific call room:
socket.on("call:incoming", ({ roomId, callType, initiator }) => {
  // show a ringing UI; call socket.emit("call:reject", {roomId}) to decline,
  // or proceed to 5.3 to answer.
});
```

### 5.3 Join the room and load the mediasoup Device

```ts
import { Device } from "mediasoup-client";

const { rtpCapabilities, role, existingProducers } = await emitAck("call:join", { roomId });

const device = new Device();
await device.load({ routerRtpCapabilities: rtpCapabilities });
```

### 5.4 Create a send transport and publish your mic/cam

```ts
const sendParams = await emitAck("call:createTransport", { roomId, direction: "send" });
const sendTransport = device.createSendTransport(sendParams);

sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
  emitAck("call:connectTransport", { roomId, transportId: sendTransport.id, dtlsParameters })
    .then(() => callback())
    .catch(errback);
});

sendTransport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
  emitAck<{ id: string }>("call:produce", {
    roomId,
    transportId: sendTransport.id,
    kind,
    rtpParameters,
    mediaTag: appData.mediaTag, // "mic" | "webcam" | "screenVideo" | "screenAudio"
  })
    .then(({ id }) => callback({ id }))
    .catch(errback);
});

const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === "video" });

const micProducer = await sendTransport.produce({
  track: stream.getAudioTracks()[0],
  appData: { mediaTag: "mic" },
});

let camProducer;
if (callType === "video") {
  camProducer = await sendTransport.produce({
    track: stream.getVideoTracks()[0],
    appData: { mediaTag: "webcam" },
  });
}
```

### 5.5 Create a recv transport and consume everyone else

```ts
const recvParams = await emitAck("call:createTransport", { roomId, direction: "recv" });
const recvTransport = device.createRecvTransport(recvParams);

recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
  emitAck("call:connectTransport", { roomId, transportId: recvTransport.id, dtlsParameters })
    .then(() => callback())
    .catch(errback);
});

async function consume(producerId: string, remoteUserId: string, mediaTag: string) {
  const params = await emitAck("call:consume", {
    roomId,
    transportId: recvTransport.id,
    producerId,
    rtpCapabilities: device.rtpCapabilities,
  });

  const consumer = await recvTransport.consume(params);
  await emitAck("call:resumeConsumer", { roomId, consumerId: consumer.id });

  // attach consumer.track to a <video>/<audio> element, keyed by
  // (remoteUserId, mediaTag) so mic+cam+screen render separately
  attachTrack(remoteUserId, mediaTag, consumer.track);
}

// Tracks that existed before you joined:
for (const p of existingProducers) await consume(p.producerId, p.userId, p.mediaTag);

// Tracks that show up later:
socket.on("call:newProducer", ({ producerId, userId, mediaTag }) => {
  if (userId !== myUserId) consume(producerId, userId, mediaTag);
});

socket.on("call:producerClosed", ({ producerId, userId }) => {
  detachTrack(userId, producerId);
});
```

### 5.6 Mute / camera off

```ts
// Client-side: also actually stop sending the pause producer, then tell the server:
await micProducer.pause();
await emitAck("call:setMute", { roomId, kind: "audio", muted: true });

// Listen for it happening to anyone (including yourself, from another device,
// or a forced mute from the host):
socket.on("call:participantMuteChanged", ({ userId, kind, muted, forced }) => {
  updateParticipantUi(userId, kind, muted);
});

// If the host force-mutes you specifically:
socket.on("call:youWereMuted", ({ kind, muted }) => {
  if (kind === "audio" && muted) micProducer.pause();
  // your UI should now disable the "unmute" button for audio -
  // the server will reject call:setMute({kind:"audio", muted:false}) while forceMuted is set.
});
```

### 5.7 Screen share

Just another produce call on the same send transport, tagged differently:

```ts
const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

const screenVideoProducer = await sendTransport.produce({
  track: screenStream.getVideoTracks()[0],
  appData: { mediaTag: "screenVideo" },
});
const screenAudioTrack = screenStream.getAudioTracks()[0];
const screenAudioProducer = screenAudioTrack
  ? await sendTransport.produce({ track: screenAudioTrack, appData: { mediaTag: "screenAudio" } })
  : null;

// Stopping:
screenStream.getVideoTracks()[0].onended = async () => {
  await emitAck("call:closeProducer", { roomId, producerId: screenVideoProducer.id });
  if (screenAudioProducer) await emitAck("call:closeProducer", { roomId, producerId: screenAudioProducer.id });
};
```

### 5.8 Host controls

```ts
await emitAck("call:kick", { roomId, targetUserId });
await emitAck("call:muteParticipant", { roomId, targetUserId, kind: "audio", muted: true });
await fetch(`/api/v1/call/${roomId}/recording/start`, { method: "POST", credentials: "include" });
```

(REST or socket both work for host actions - REST is convenient from an admin dashboard that isn't holding a live socket, sockets are convenient from the in-call UI since you already have the connection open.)

### 5.9 Leaving / cleanup

```ts
async function leaveCall() {
  sendTransport.close(); // also closes mic/cam/screen producers
  recvTransport.close(); // also closes consumers
  await emitAck("call:leave", { roomId });
}

socket.on("call:ended", ({ roomId: endedRoomId }) => {
  if (endedRoomId === roomId) leaveCall();
});
socket.on("call:kicked", ({ roomId: kickedRoomId }) => {
  if (kickedRoomId === roomId) teardownCallUi();
});
```

Also call `leaveCall()` on `window.beforeunload` / route change so the server finds out promptly instead of waiting for the socket disconnect timeout.

---

## 6. Environment variables

All optional with sane defaults - only set these if you need to override:

| Var | Default | Purpose |
|---|---|---|
| `MEDIASOUP_MIN_PORT` / `MEDIASOUP_MAX_PORT` | `40000` / `49999` | UDP/TCP range mediasoup listens on. Must be open on the firewall |
| `MEDIASOUP_NUM_WORKERS` | number of CPU cores | One OS process per worker |
| `ANNOUNCED_ADDRESS` | unset (falls back to `127.0.0.1`, dev-only) | **Set this in production** - the public IP clients should send ICE candidates to |
| `CALL_RECORDING_DIR` | `CallRecordings` | Where recorded files land (private, not statically served) |
| `FFMPEG_PATH` | `ffmpeg` | Binary used for recording; recording fails gracefully (marks the `CallRecording` `failed`) if missing |
| `CALL_RING_TIMEOUT_MS` | `45000` | Ad-hoc call auto-cancels if nobody answers in time |
| `CALL_MAX_PARTICIPANTS` | `8` | Per-room cap |

`ANNOUNCED_ADDRESS` is the one you actually need to set for anything beyond local dev - without it, ICE candidates are only valid for `127.0.0.1` and nothing outside the server machine can connect.

---

## 7. Known limitations

- Single-process only (see architecture note above) - no sticky-session/clustering support yet.
- Recording captures each track to its own file (mic+cam per participant, screen separately) rather than a single mixed/composited file; combining them is a post-processing step, not something this service does.
- No TURN server configuration is included - if clients are behind restrictive NATs/symmetric firewalls, you'll want to add TURN credentials to the client-side `iceServers` config (mediasoup only handles the server side of ICE; TURN relay is a separate piece of infrastructure).
