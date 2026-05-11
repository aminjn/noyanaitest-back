import { createWorker } from "mediasoup";

export const createMediasoupWorker = async () => {
  const worker = await createWorker({
    logLevel: "warn",
    logTags: [
      "bwe",
      "dtls",
      "ice",
      "info",
      "message",
      "rtcp",
      "rtp",
      "rtx",
      "score",
      "sctp",
      "simulcast",
      "srtp",
      "svc",
    ],
  });
  worker.on("died", (error) => {
    console.log("Worker Died");
    console.log(error);
    process.exit(1);
  });
  return worker;
};
