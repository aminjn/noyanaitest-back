import { Server } from "socket.io";
import { Server as HttpServer } from "http";

import * as mediasoup from "mediasoup";
import { Client } from "./Client";
import { Room } from "./Room";
import { createWebRtcTransportOption } from "./mediaSoupConfig";

const initSocket = (server: HttpServer, worker: mediasoup.types.Worker) => {
  const io = new Server(server, {
    path: "/api/socket.io",
  });
  4;
  io.on("connect", (socket) => {
    console.log("connected");

    socket.on(
      "joinRoom",
      (
        { userName, roomName }: { userName: string; roomName: string },
        joinCb,
      ) => {
        const client = new Client({ userName });
        let room = Room.rooms.find((room) => room.roomName === roomName);
        if (!room) room = new Room({ roomName, worker });
        room.addClient(client);
        joinCb({ state: "Success", roomName: room.roomName });

        socket.on("getRtpCap", (cb) => {
          const rtpCap = room.getRtpCap();
          if (!rtpCap) return cb("Error");
          cb(rtpCap);
        });

        socket.on(
          "requestTransport",
          async ({ kind }: { kind: "Produce" | "Consume" }, ack) => {
            if (!room.router) return ack("Error");
            const transport = await room.router.createWebRtcTransport(
              createWebRtcTransportOption,
            );
            if (kind === "Produce") {
              client.addProducerTransport(transport);
            } else {
              client.addConsumerTransport(transport);
            }
            const clientTransportParams = {
              id: transport.id,
              dtlsParameters: transport.dtlsParameters,
              iceCandidates: transport.iceCandidates,
              iceParameters: transport.iceParameters,
            };
            ack(clientTransportParams);
          },
        );

        socket.on(
          "connectTransport",
          async ({ dtlsParameters, id, kind }, ack) => {
            console.log({ kind });
            const transport = client[
              kind === "Produce" ? "produceTransports" : "consumeTransports"
            ].find((transport) => transport.id === id);
            if (!transport) {
              console.log("Tried To Connect A Transport That Does not Exist");
              ack("Error");
              return;
            }
            try {
              await transport.connect({ dtlsParameters });
              ack("Success");
            } catch (err) {
              console.log("Error Connecting Transport");
              console.log(err);
              ack("Error");
            }
          },
        );

        socket.on(
          "startProducing",
          async ({ kind, rtpParameters, transportId }, ack) => {
            const transport = client.produceTransports.find(
              (transport) => transport.id === transportId,
            );
            if (!transport) {
              console.log(
                "Attempted To Start Producing On A Nonexisting Transport",
              );
              ack("Error");
              return;
            }
            const producer = await transport.produce({ kind, rtpParameters });
            client.addProducer(producer);
            ack(producer.id);
          },
        );

        socket.on("getAvailableProducers", (ack) => {
          console.log(room.clients);
          const producers = room.clients
            .filter((c) => c !== client)
            .reduce(
              (acc, client) => [...acc, ...client.producers],
              [] as mediasoup.types.Producer[],
            );
          ack(producers.map((producer) => producer.id));
        });

        socket.on(
          "initConsume",
          async ({ rtpCapabilities, producerId, transportId }, ack) => {
            const transport = client.consumeTransports.find(
              (transport) => transport.id === transportId,
            );
            if (!transport) {
              console.log(
                "Attempting to consume On a Transport That Does NOT Exist",
              );
              ack("Error");
              return;
            }
            if (!room.router) {
              console.log("Room Router Is NOT Ready");
              return ack("Error");
            }
            if (!room.router.canConsume({ producerId, rtpCapabilities }))
              return ack("Cant");
            const consumer = await transport.consume({
              producerId,
              paused: true,
              rtpCapabilities,
            });
            client.addConsumer(consumer);
            const consumerParams = {
              id: consumer.id,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
            };
            ack(consumerParams);
          },
        );

        socket.on("resumeConsume", async ({ consumerId }, ack) => {
          const consumer = client.consumers.find(
            (consumer) => consumer.id === consumerId,
          );
          if (!consumer) return ack("Error");
          try {
            await consumer.resume();
            ack("Success");
          } catch (err) {
            console.log("Error Resuming Consumer");
            console.log(err);
            ack("Error");
          }
        });

        //
      },
    );
  });

  return io;
};

export default initSocket;
