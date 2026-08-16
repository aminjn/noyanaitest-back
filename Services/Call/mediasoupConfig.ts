import * as mediasoup from "mediasoup";
import { announcedAddress, MEDIASOUP_MIN_PORT, MEDIASOUP_MAX_PORT } from "../../Lib/Env";

// Codecs offered by every call Router. Opus for audio; VP8 + H264 for video
// so both Chromium-family browsers (VP8) and Safari/iOS (H264) work well.
export const routerMediaCodecs: mediasoup.types.RouterRtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 1000,
    },
  },
];

// Options used to create every WebRTC (send/recv) transport. Each worker
// already only listens on its own slice of the RTC port range (see
// workerPool.ts), so nothing worker-specific needs to happen here.
export const webRtcTransportOptions: mediasoup.types.WebRtcTransportOptions = {
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 1_000_000,
  listenInfos: [
    {
      protocol: "udp",
      ip: announcedAddress ? "0.0.0.0" : "127.0.0.1",
      announcedAddress,
    },
    {
      protocol: "tcp",
      ip: announcedAddress ? "0.0.0.0" : "127.0.0.1",
      announcedAddress,
    },
  ],
};

// Options for the internal (server-side, non-ICE) transports used to feed
// recorded RTP into ffmpeg. These always listen on loopback since ffmpeg
// runs on the same host as the mediasoup worker.
export const plainRecordingTransportOptions: mediasoup.types.PlainTransportOptions =
  {
    listenIp: { ip: "127.0.0.1", announcedIp: undefined },
    rtcpMux: true,
    comedia: false,
  };

export const DEFAULT_RTC_MIN_PORT = MEDIASOUP_MIN_PORT;
export const DEFAULT_RTC_MAX_PORT = MEDIASOUP_MAX_PORT;
