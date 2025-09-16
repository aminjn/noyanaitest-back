import { Server } from "socket.io";
import { Server as HttpServer } from "http";
import { useUser } from "./middleware/useUser";
import { fartHandler } from "./controller/controllers";
import { LoginError, NotFoundError } from "../Lib/AppError";
import CallRoom from "../Models/CallRoom";
import { isValidObjectId } from "mongoose";

const initSocket = (server: HttpServer) => {
  const io = new Server(server, {
    path: "/api/socket.io",
  });

  io.use(useUser);

  io.on("connection", async (socket) => {
    console.log("connection acquired");

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

    socket.on("disconnect", () => {
      console.log("connection lost");
    });
  });

  return io;
};

export default initSocket;
