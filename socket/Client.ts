import * as mediasoup from "mediasoup";
export class Client {
  userName: string;
  produceTransports: mediasoup.types.WebRtcTransport[] = [];
  consumeTransports: mediasoup.types.WebRtcTransport[] = [];
  producers: mediasoup.types.Producer[] = [];
  consumers: mediasoup.types.Consumer[] = [];

  constructor({ userName }: { userName: string }) {
    this.userName = userName;
  }

  addProducerTransport(transport: mediasoup.types.WebRtcTransport) {
    this.produceTransports.push(transport);
  }

  addConsumerTransport(transport: mediasoup.types.WebRtcTransport) {
    this.consumeTransports.push(transport);
  }

  addProducer(producer: mediasoup.types.Producer) {
    this.producers.push(producer);
  }

  addConsumer(consumer: mediasoup.types.Consumer) {
    this.consumers.push(consumer);
  }
}
