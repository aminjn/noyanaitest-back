import * as mediasoup from "mediasoup";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs/promises";
import path from "path";

import * as env from "../../Lib/Env";
import CallRecording from "../../Models/CallRecording";
import CallParticipant from "../../Models/CallParticipant";
import { plainRecordingTransportOptions } from "./mediasoupConfig";
import { ProducerAppData } from "./types";

// Server-side recording, following the same approach as the official
// mediasoup "record" demo: for a given Producer, spin up a PlainTransport
// on the same Router, Consume the producer into it, point it at a UDP port
// that ffmpeg is listening on (described via a throwaway .sdp file), and let
// ffmpeg remux the raw RTP straight into a file with `-c copy` (no
// transcoding, so this is cheap on CPU).
//
// This is inherently best-effort: it requires an `ffmpeg` binary on the
// host (see Lib/Env.ts FFMPEG_PATH) and enough free loopback UDP ports.
// Failures are caught and reflected on the CallRecording document's
// `status`/`error` fields rather than throwing into the caller, so one
// broken recording never takes a live call down.

type RecordingHandle = {
  recordingId: string;
  roomId: string;
  userId: string;
  producerId: string;
  port: number;
  sdpPath: string;
  filePath: string;
  plainTransport: mediasoup.types.PlainTransport;
  consumer: mediasoup.types.Consumer;
  ffmpeg: ChildProcessWithoutNullStreams;
  stopped: boolean;
};

const activeRecordings: Map<string, RecordingHandle> = new Map();
const roomIndex: Map<string, Set<string>> = new Map();

const FFMPEG_PORT_BASE = 15000;
const FFMPEG_PORT_MAX = 19998;
const usedPorts: Set<number> = new Set();

const allocatePort = (): number => {
  for (let port = FFMPEG_PORT_BASE; port <= FFMPEG_PORT_MAX; port += 2) {
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error("No free recording ports available");
};

const releasePort = (port: number) => usedPorts.delete(port);

const ensureRecordingDir = async (): Promise<string> => {
  const dir = path.join(process.cwd(), env.CALL_RECORDING_DIR);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
};

const buildSdp = ({
  ip,
  port,
  kind,
  codec,
}: {
  ip: string;
  port: number;
  kind: mediasoup.types.MediaKind;
  codec: mediasoup.types.RtpCodecParameters;
}): string => {
  const payloadType = codec.payloadType;
  const encodingName = codec.mimeType.split("/")[1];
  const rtpmap =
    kind === "audio"
      ? `a=rtpmap:${payloadType} ${encodingName}/${codec.clockRate}/${codec.channels || 2}`
      : `a=rtpmap:${payloadType} ${encodingName}/${codec.clockRate}`;
  const fmtpEntries = codec.parameters
    ? Object.entries(codec.parameters)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${k}=${v}`)
    : [];
  const fmtp = fmtpEntries.length
    ? `a=fmtp:${payloadType} ${fmtpEntries.join(";")}`
    : "";

  return (
    [
      "v=0",
      `o=- 0 0 IN IP4 ${ip}`,
      "s=noyanai-call-recording",
      `c=IN IP4 ${ip}`,
      "t=0 0",
      `m=${kind} ${port} RTP/AVP ${payloadType}`,
      rtpmap,
      fmtp,
      "a=recvonly",
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
};

const finalizeRecording = async (
  recordingId: string,
  ok: boolean,
  error?: string,
) => {
  await CallRecording.findByIdAndUpdate(recordingId, {
    status: ok ? "ready" : "failed",
    endedAt: new Date(),
    ...(error && { error }),
  }).catch((err) =>
    console.log("[call] failed to finalize recording doc", err),
  );
};

const cleanupHandle = (handle: RecordingHandle) => {
  activeRecordings.delete(handle.recordingId);
  roomIndex.get(handle.roomId)?.delete(handle.recordingId);
  releasePort(handle.port);
  fs.unlink(handle.sdpPath).catch(() => {});
  if (!handle.consumer.closed) handle.consumer.close();
  if (!handle.plainTransport.closed) handle.plainTransport.close();
};

export const recordSingleProducer = async ({
  roomId,
  router,
  userId,
  producer,
  startedBy,
}: {
  roomId: string;
  router: mediasoup.types.Router;
  userId: string;
  producer: mediasoup.types.Producer<ProducerAppData>;
  startedBy: string;
}): Promise<void> => {
  const alreadyRecording = Array.from(activeRecordings.values()).some(
    (h) => h.producerId === producer.id,
  );
  if (alreadyRecording) return;

  const dir = await ensureRecordingDir();
  const port = allocatePort();
  const mediaTag = producer.appData.mediaTag;
  const kind = producer.kind;

  let plainTransport: mediasoup.types.PlainTransport | undefined;
  let consumer: mediasoup.types.Consumer | undefined;
  let recordingId: string | undefined;

  try {
    plainTransport = await router.createPlainTransport(
      plainRecordingTransportOptions,
    );
    consumer = await plainTransport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });

    const codec = consumer.rtpParameters.codecs[0];
    if (!codec) throw new Error("Consumer has no negotiated codec");
    const isH264 = codec.mimeType.toLowerCase().includes("h264");
    const container = kind === "audio" ? "webm" : isH264 ? "mp4" : "webm";

    const participantDoc = await CallParticipant.findOne({
      room: roomId,
      user: userId,
    });

    const fileBase = `${roomId}_${userId}_${mediaTag}_${Date.now()}`;
    const filePath = path.join(dir, `${fileBase}.${container}`);
    const sdpPath = path.join(dir, `${fileBase}.sdp`);

    await fs.writeFile(
      sdpPath,
      buildSdp({ ip: "127.0.0.1", port, kind, codec }),
    );

    const recording = await CallRecording.create({
      room: roomId,
      participant: participantDoc?._id,
      startedBy,
      kind:
        mediaTag === "screenVideo" || mediaTag === "screenAudio"
          ? "screen"
          : "participant",
      filePath: path.relative(process.cwd(), filePath),
      format: container,
      status: "recording",
    });
    recordingId = recording._id.toString();

    await plainTransport.connect({ ip: "127.0.0.1", port });

    const ffmpegArgs = [
      "-loglevel",
      "warning",
      "-protocol_whitelist",
      "file,udp,rtp",
      "-i",
      sdpPath,
      "-c",
      "copy",
      ...(container === "mp4"
        ? ["-movflags", "frag_keyframe+empty_moov+default_base_moof"]
        : []),
      "-f",
      container,
      "-y",
      filePath,
    ];
    const ffmpeg = spawn(env.FFMPEG_PATH, ffmpegArgs);

    let stderrTail = "";
    ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    const handle: RecordingHandle = {
      recordingId,
      roomId,
      userId,
      producerId: producer.id,
      port,
      sdpPath,
      filePath,
      plainTransport,
      consumer,
      ffmpeg,
      stopped: false,
    };
    activeRecordings.set(recordingId, handle);
    if (!roomIndex.has(roomId)) roomIndex.set(roomId, new Set());
    roomIndex.get(roomId)!.add(recordingId);

    ffmpeg.on("error", (err) => {
      cleanupHandle(handle);
      finalizeRecording(recordingId!, false, err.message);
    });
    ffmpeg.on("exit", (code, signal) => {
      cleanupHandle(handle);
      const ok = handle.stopped || code === 0;
      finalizeRecording(
        recordingId!,
        ok,
        ok
          ? undefined
          : `ffmpeg exited (code=${code} signal=${signal}): ${stderrTail}`,
      );
    });

    await consumer.resume();
  } catch (err) {
    if (recordingId) {
      await finalizeRecording(
        recordingId,
        false,
        err instanceof Error ? err.message : "Unknown recording error",
      );
    }
    if (consumer && !consumer.closed) consumer.close();
    if (plainTransport && !plainTransport.closed) plainTransport.close();
    releasePort(port);
    throw err;
  }
};

const stopRecordingById = async (recordingId: string) => {
  const handle = activeRecordings.get(recordingId);
  if (!handle) return;
  handle.stopped = true;
  try {
    handle.ffmpeg.kill("SIGINT");
  } catch {
    // process may already be gone; the exit handler is a no-op in that case
  }
};

export const stopAllRecordingsForRoom = async (roomId: string) => {
  const ids = Array.from(roomIndex.get(roomId) || []);
  await Promise.all(ids.map((id) => stopRecordingById(id)));
};
