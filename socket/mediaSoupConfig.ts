import * as mediasoup from "mediasoup";
export const routerMediaCodecs: mediasoup.types.RouterRtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
];

export const createWebRtcTransportOption: mediasoup.types.WebRtcTransportOptions =
  {
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    listenInfos: [
      { protocol: "udp", ip: "127.0.0.1" },
      { protocol: "tcp", ip: "127.0.0.1" },
    ],
  };
