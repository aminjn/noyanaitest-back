import { Socket } from "socket.io";

export const fartHandler = async (data: unknown, socket: Socket) => {
  if (!socket.user) throw new Error("You are not allowed to fart");
  console.log("farted");
};
