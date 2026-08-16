import * as mediasoup from "mediasoup";
import {
  MEDIASOUP_NUM_WORKERS,
  MEDIASOUP_MIN_PORT,
  MEDIASOUP_MAX_PORT,
} from "../../Lib/Env";

// One mediasoup Worker == one OS process handling media for however many
// Routers (call rooms) get assigned to it. We spin up a small pool at boot
// and hand out routers round-robin so load spreads across CPU cores instead
// of funneling every call through a single worker process.
let workers: mediasoup.types.Worker[] = [];
let nextWorkerIndex = 0;

const totalPorts = MEDIASOUP_MAX_PORT - MEDIASOUP_MIN_PORT + 1;

const portRangeForWorker = (index: number, count: number) => {
  const slice = Math.max(2, Math.floor(totalPorts / count));
  const rtcMinPort = MEDIASOUP_MIN_PORT + index * slice;
  const isLast = index === count - 1;
  const rtcMaxPort = isLast
    ? MEDIASOUP_MAX_PORT
    : Math.min(rtcMinPort + slice - 1, MEDIASOUP_MAX_PORT);
  return { rtcMinPort, rtcMaxPort };
};

export const initWorkers = async (): Promise<mediasoup.types.Worker[]> => {
  if (workers.length) return workers;

  const count = Math.max(1, MEDIASOUP_NUM_WORKERS);

  for (let i = 0; i < count; i++) {
    const { rtcMinPort, rtcMaxPort } = portRangeForWorker(i, count);
    const worker = await mediasoup.createWorker({
      logLevel: "warn",
      logTags: [
        "info",
        "ice",
        "dtls",
        "rtp",
        "srtp",
        "rtcp",
        "rtx",
        "bwe",
        "score",
        "simulcast",
        "svc",
        "sctp",
      ],
      rtcMinPort,
      rtcMaxPort,
    });

    worker.on("died", (error) => {
      console.log(`[call] mediasoup Worker ${worker.pid} died`);
      console.log(error);
      // Drop it from the pool so we stop handing out routers on a dead
      // worker; existing rooms on it will error out and clients can retry.
      workers = workers.filter((w) => w !== worker);
    });

    workers.push(worker);
  }

  console.log(`[call] started ${workers.length} mediasoup worker(s)`);
  return workers;
};

export const getNextWorker = (): mediasoup.types.Worker => {
  if (!workers.length) throw new Error("Mediasoup workers not initialized");
  const worker = workers[nextWorkerIndex % workers.length];
  nextWorkerIndex += 1;
  return worker;
};

export const getWorkers = (): mediasoup.types.Worker[] => workers;
