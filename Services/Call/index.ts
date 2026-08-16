import { Server as HttpServer } from "http";
import { Server as IOServer } from "socket.io";

import { initWorkers } from "./workerPool";
import { initCallSocket } from "./callSocket";
import { callService } from "./CallService";

// Boots the call subsystem: spins up the mediasoup worker pool, creates the
// socket.io server used for call signaling, and wires CallService up to it
// so REST controllers (which only touch CallService, never sockets/mediasoup
// directly) can push realtime events (ringing, participant joined, muted,
// kicked, etc.) to connected clients.
export const initCallService = async (server: HttpServer): Promise<IOServer> => {
  await initWorkers();

  const io = new IOServer(server, { path: "/api/socket.io" });
  callService.attachIo(io);
  initCallSocket(io);

  return io;
};

export { callService } from "./CallService";
export * from "./types";
