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
      "signal",
      safeHandler(async (data) => {
        if (!socket.user) throw new LoginError();
        if (!data.room || !isValidObjectId(data.room))
          throw new Error("Bad Room");
        const room = await CallRoom.findOne({
          _id: data.room,
          participants: socket.user._id,
        });
        if (!room) throw new NotFoundError("room");
        console.log("signal");
        io.to(room._id.toString()).emit("signal", {
          from: socket.user._id,
          ...data,
        });
      })
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
        const socketRoom = io.sockets.adapter.rooms.get(room._id.toString());
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
                `sent peerJoin from ${socket.user?.phone} to ${party.user.phone}`
              );
            }
          });
        }
      })
    );

    socket.on("offer", async ({ sdp, room }) => {
      if (!socket.user) throw new LoginError();
      if (!isValidObjectId(room)) throw new BadInputError();
      const callRoom = await CallRoom.findOne({
        _id: room,
        participants: socket.user._id,
      });
      if (!callRoom) throw new NotFoundError();
      console.log("Offer received");
      const socketRoom = io.sockets.adapter.rooms.get(callRoom._id.toString());
      if (socketRoom) {
        socketRoom.forEach((id) => {
          const party = io.sockets.sockets.get(id);
          if (
            party &&
            party.user &&
            party.user._id.toString() !== socket.user?._id.toString()
          ) {
            io.to(party.user._id.toString()).emit("getOffer", sdp);
            console.log(
              `forwarded offer from ${socket.user?.phone} to ${party.user.phone}`
            );
          }
        });
      }
    });

    socket.on("answer", async ({ sdp, room }) => {
      if (!socket.user) throw new LoginError();
      if (!isValidObjectId(room)) throw new BadInputError();
      const callRoom = await CallRoom.findOne({
        _id: room,
        participants: socket.user._id,
      });
      if (!callRoom) throw new NotFoundError();
      console.log("Answer received");
      const socketRoom = io.sockets.adapter.rooms.get(callRoom._id.toString());
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
    });

    socket.on("disconnect", () => {
      console.log(`${socket.user?.phone || "unknown"} disconnected`);
    });
  });

  return io;
};

export default initSocket;
