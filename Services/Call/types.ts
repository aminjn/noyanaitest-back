import * as mediasoup from "mediasoup";

// What a given Producer actually carries. Used both to tag producers
// (appData.mediaTag) so peers know how to render them, and to decide
// which producers are eligible for recording/screen-share handling.
export const mediaTags = ["mic", "webcam", "screenVideo", "screenAudio"] as const;

export type MediaTag = (typeof mediaTags)[number];

export type ProducerAppData = mediasoup.types.AppData & {
  userId: string;
  mediaTag: MediaTag;
};

export type TransportDirection = "send" | "recv";

export type TransportAppData = mediasoup.types.AppData & {
  userId: string;
  direction: TransportDirection;
};

// Serialized shape sent to clients describing a producer that already
// exists in the room when they join, or that just appeared.
export type ProducerInfo = {
  producerId: string;
  userId: string;
  mediaTag: MediaTag;
};

export type MuteKind = "audio" | "video";
