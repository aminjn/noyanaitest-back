import * as mediasoup from "mediasoup";
import { announcedAddress } from "../Lib/Env";
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
      {
        protocol: "udp",
        ip: !!announcedAddress ? "0.0.0.0" : "127.0.0.1",
        announcedAddress,
      },
      {
        protocol: "tcp",
        ip: !!announcedAddress ? "0.0.0.0" : "127.0.0.1",
        announcedAddress,
      },
    ],
  };
