import { Server } from "socket.io";
import { Server as HttpServer } from "http";
import { useUser } from "./middleware/useUser";
import { fartHandler } from "./controller/controllers";
import { BadInputError, LoginError, NotFoundError } from "../Lib/AppError";
import CallRoom from "../Models/CallRoom";
import { isValidObjectId } from "mongoose";

const initSocket = (server: HttpServer) => {
  const io = new Server(server, {
    path: "/api/socket.io",
  });

  io.use(useUser);

  io.on("connection", async (socket) => {
    const safeHandler = (handler: (data: any) => Promise<void> | void) => {
      return async (data: any) => {
        try {
          await handler(data);
        } catch (err: any) {
          console.log(err.message);
          socket.emit("error", err.message);
        }
      };
    };

    socket.on(
      "fart",
      safeHandler((data) => fartHandler(data, socket))
    );

    socket.on(
      "peerJoin",
      safeHandler(async (roomId) => {
        if (!socket.user) throw new LoginError();
        if (!isValidObjectId(roomId)) throw new BadInputError();
        const room = await CallRoom.findOne({
          _id: roomId,
          participants: socket.user._id,
        });
        if (!room) throw new NotFoundError();
        console.log(`Peer Joined ${socket.user.phone}`);
        const userSockets = io.sockets.adapter.rooms.get(
          socket.user._id.toString()
        );
        if (userSockets) {
          userSockets.forEach((id) => {
            const soc = io.sockets.sockets.get(id);
            if (soc?.inCall && soc.id !== socket.id)
              throw new Error("در حال حاضر در تماس دیگری هستید");
          });
        }
        await socket.join(room._id.toString());
        const socketRoom = io.sockets.adapter.rooms.get(room._id.toString());
        socket.inCall = true;
        console.log(socketRoom);
        if (socketRoom) {
          socketRoom.forEach((id) => {
            const party = io.sockets.sockets.get(id);
            if (
              party &&
              party.user &&
              party.user._id.toString() !== socket.user?._id.toString()
            ) {
              io.to(party.user._id.toString()).emit("peerJoin");
              console.log(
                `forwarded peerJoin from ${socket.user?.phone} to ${party.user.phone}`
              );
            }
          });
        }
      })
    );

    socket.on(
      "offer",
      safeHandler(async ({ sdp, room }) => {
        if (!socket.inCall) return;
        if (!socket.user) throw new LoginError();
        if (!isValidObjectId(room)) throw new BadInputError();
        const callRoom = await CallRoom.findOne({
          _id: room,
          participants: socket.user._id,
        });
        if (!callRoom) throw new NotFoundError();
        console.log("Offer received");
        const socketRoom = io.sockets.adapter.rooms.get(
          callRoom._id.toString()
        );
        if (socketRoom) {
          socketRoom.forEach((id) => {
            const party = io.sockets.sockets.get(id);
            if (
              party &&
              party.user &&
              party.user._id.toString() !== socket.user?._id.toString() &&
              party.inCall
            ) {
              io.to(party.user._id.toString()).emit("getOffer", sdp);
              console.log(
                `forwarded offer from ${socket.user?.phone} to ${party.user.phone}`
              );
            }
          });
        }
      })
    );

    socket.on(
      "answer",
      safeHandler(async ({ sdp, room }) => {
        if (!socket.inCall) return;
        if (!socket.user) throw new LoginError();
        if (!isValidObjectId(room)) throw new BadInputError();
        const callRoom = await CallRoom.findOne({
          _id: room,
          participants: socket.user._id,
        });
        if (!callRoom) throw new NotFoundError();
        console.log("Answer received");
        const socketRoom = io.sockets.adapter.rooms.get(
          callRoom._id.toString()
        );
        if (socketRoom) {
          socketRoom.forEach((id) => {
            const party = io.sockets.sockets.get(id);
            if (
              party &&
              party.user &&
              party.user._id.toString() !== socket.user?._id.toString()
            ) {
              io.to(party.user._id.toString()).emit("getAnswer", sdp);
              console.log(
                `forwarded answer from ${socket.user?.phone} to ${party.user.phone}`
              );
            }
          });
        }
      })
    );

    socket.on(
      "candidate",
      safeHandler(async ({ candidate, room }) => {
        if (!socket.inCall) return;
        if (!socket.user) throw new LoginError();
        if (!isValidObjectId(room)) throw new BadInputError();
        const callRoom = await CallRoom.findOne({
          _id: room,
          participants: socket.user._id,
        });
        if (!callRoom) throw new NotFoundError();
        console.log("Candidate received");
        const socketRoom = io.sockets.adapter.rooms.get(
          callRoom._id.toString()
        );
        if (socketRoom) {
          socketRoom.forEach((id) => {
            const party = io.sockets.sockets.get(id);
            if (
              party &&
              party.user &&
              party.user._id.toString() !== socket.user?._id.toString()
            ) {
              io.to(party.user._id.toString()).emit("getCandidate", candidate);
              console.log(
                `forwarded candidate from ${socket.user?.phone} to ${party.user.phone}`
              );
            }
          });
        }
      })
    );

    socket.on(
      "leaveCall",
      safeHandler(async (roomId) => {
        if (!socket.inCall) return;
        if (!socket.user) throw new LoginError();
        if (!isValidObjectId(roomId)) throw new BadInputError();
        const callRoom = await CallRoom.findOne({
          _id: roomId,
          participants: socket.user._id,
        });
        if (!callRoom) throw new NotFoundError();
        console.log(`${socket.user?.phone} left call`);
        await socket.leave(callRoom._id.toString());
        const roomSockets = io.sockets.adapter.rooms.get(
          callRoom._id.toString()
        );
        if (roomSockets) {
          roomSockets.forEach((id) => {
            const party = io.sockets.sockets.get(id);
            if (
              party &&
              party.user &&
              party.user._id.toString() !== socket.user?._id.toString()
            ) {
              io.to(party.user._id.toString()).emit("peerLeft");
              console.log(
                `notified ${party.user.phone} that ${socket.user?.phone} left the call`
              );
            }
          });
        }
        socket.inCall = false;
      })
    );

    socket.on("disconnecting", () => {
      console.log(`${socket.user?.phone} is disconnecting`);
      if (!socket.user) return;
      if (socket.inCall) {
        socket.rooms.forEach(async (roomId) => {
          if (isValidObjectId(roomId)) {
            if (socket.user?._id.toString() !== roomId) {
              const isCallRoom = await CallRoom.exists({
                _id: roomId,
                participants: socket.user?._id,
              });
              if (isCallRoom) {
                const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
                if (socketsInRoom) {
                  socketsInRoom.forEach((id) => {
                    const party = io.sockets.sockets.get(id);
                    if (
                      party &&
                      party.user &&
                      party.user._id.toString() !== socket.user?._id.toString()
                    ) {
                      io.to(party.user._id.toString()).emit("peerLeft");
                      console.log(
                        `notified ${party.user.phone} that ${socket.user?.phone} left the call`
                      );
                    }
                  });
                }
              }
            }
          }
        });
      }
    });

    socket.on("disconnect", () => {
      console.log(`${socket.user?.phone || "unknown"} disconnected`);
    });
  });

  return io;
};

export default initSocket;
