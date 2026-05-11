import * as mediasoup from "mediasoup";
import { Client } from "./Client";
import { routerMediaCodecs } from "./mediaSoupConfig";
export class Room {
  roomName: string;
  worker: mediasoup.types.Worker;
  clients: Client[] = [];
  router: mediasoup.types.Router | null = null;

  static rooms: Room[] = [];
  constructor({
    roomName,
    worker,
  }: {
    roomName: string;
    worker: mediasoup.types.Worker;
  }) {
    this.roomName = roomName;
    this.worker = worker;
    Room.rooms.push(this);
    worker
      .createRouter({
        mediaCodecs: routerMediaCodecs,
      })
      .then((router) => (this.router = router));
  }

  addClient(client: Client) {
    if (this.clients.includes(client)) return;
    this.clients.push(client);
  }

  getRtpCap() {
    if (!this.router) return null;
    return this.router.rtpCapabilities;
  }
}
