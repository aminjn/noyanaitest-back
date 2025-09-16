import { ExtendedError, Socket } from "socket.io";
import User, { IUser } from "../../Models/User";
import { extractDataFromCookie } from "../../Controllers/authController";
import * as cookie from "cookie";

export const useUser = async (
  socket: Socket,
  next: (err?: ExtendedError | undefined) => void
) => {
  console.log("use");
  const rawCookies = socket.handshake.headers.cookie;
  const bakedCookies = rawCookies ? cookie.parse(rawCookies) : {};
  const token = bakedCookies.token;
  let user: IUser | undefined | null;
  if (token) {
    const decoded = await extractDataFromCookie({
      cookie: token,
      name: "token",
    });
    if (decoded) {
      //TODO: maybe check if user is logged out
      user = await User.findById(decoded.id);
      socket.user = user;
      if (user) {
        socket.join(user._id.toString());
      }
    }
  }
  next();
};
