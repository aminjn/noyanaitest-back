import * as mediasoup from "mediasoup";
import { ProducerAppData, TransportAppData } from "./types";

// Everything below is process-local, in-memory state for calls that are
// currently live: mediasoup Router/Transport/Producer/Consumer objects
// cannot be persisted, so this sits alongside (not instead of) the Mongo
// documents in Models/CallRoom.ts & friends, which hold the durable record
// of who's invited/joined/muted/etc.
//
// NOTE: this only works as long as a single Node process owns a given call
// room. If this service is ever run with multiple instances behind a load
// balancer, calls need sticky routing (or a proper SFU-cluster setup) so all
// signaling for one room lands on the process that owns its mediasoup
// Router.

export class RuntimeParticipant {
  readonly userId: string;
  // A user can have more than one live socket (multiple tabs/devices); we
  // track all of them so we can clean up correctly on any single disconnect.
  readonly socketIds: Set<string> = new Set();
  readonly sendTransports: Map<
    string,
    mediasoup.types.WebRtcTransport<TransportAppData>
  > = new Map();
  readonly recvTransports: Map<
    string,
    mediasoup.types.WebRtcTransport<TransportAppData>
  > = new Map();
  readonly producers: Map<string, mediasoup.types.Producer<ProducerAppData>> =
    new Map();
  readonly consumers: Map<string, mediasoup.types.Consumer> = new Map();

  constructor(userId: string) {
    this.userId = userId;
  }

  async close(): Promise<void> {
    for (const transport of this.sendTransports.values()) {
      if (!transport.closed) transport.close();
    }
    for (const transport of this.recvTransports.values()) {
      if (!transport.closed) transport.close();
    }
    this.sendTransports.clear();
    this.recvTransports.clear();
    // Producers/Consumers close automatically when their parent transport
    // closes; just drop our references.
    this.producers.clear();
    this.consumers.clear();
    this.socketIds.clear();
  }
}

export class RuntimeRoom {
  readonly roomId: string;
  readonly router: mediasoup.types.Router;
  readonly participants: Map<string, RuntimeParticipant> = new Map();

  constructor(roomId: string, router: mediasoup.types.Router) {
    this.roomId = roomId;
    this.router = router;
  }

  getOrCreateParticipant(userId: string): RuntimeParticipant {
    let participant = this.participants.get(userId);
    if (!participant) {
      participant = new RuntimeParticipant(userId);
      this.participants.set(userId, participant);
    }
    return participant;
  }

  allProducers(): {
    userId: string;
    producer: mediasoup.types.Producer<ProducerAppData>;
  }[] {
    const list: {
      userId: string;
      producer: mediasoup.types.Producer<ProducerAppData>;
    }[] = [];
    for (const participant of this.participants.values()) {
      for (const producer of participant.producers.values()) {
        list.push({ userId: participant.userId, producer });
      }
    }
    return list;
  }

  isEmpty(): boolean {
    for (const participant of this.participants.values()) {
      if (participant.socketIds.size > 0) return false;
    }
    return true;
  }

  async close(): Promise<void> {
    for (const participant of this.participants.values()) {
      await participant.close();
    }
    this.participants.clear();
    if (!this.router.closed) this.router.close();
  }
}

class CallRuntimeRegistry {
  private rooms: Map<string, RuntimeRoom> = new Map();

  has(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  get(roomId: string): RuntimeRoom | undefined {
    return this.rooms.get(roomId);
  }

  set(roomId: string, room: RuntimeRoom): void {
    this.rooms.set(roomId, room);
  }

  delete(roomId: string): void {
    this.rooms.delete(roomId);
  }

  values(): IterableIterator<RuntimeRoom> {
    return this.rooms.values();
  }
}

export const callRuntime = new CallRuntimeRegistry();
