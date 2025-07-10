import express from "express";
import cookieParser from "cookie-parser";
import path from "path";

import errorController from "./Controllers/errorController";

import "./Models/Blog";
import "./Models/BlogCategory";
import "./Models/PendingUser";
import "./Models/Token";
import "./Models/User";
import "./Models/UserSecurity";

import userRouter from "./Routers/userRouter";
import authRouter from "./Routers/authRouter";
import autoRouter from "./Routers/autoRouter";
import publicRouter from "./Routers/publicRouter";

const app = express();

app.use(cookieParser());

app.use(express.json());

app.use(express.static(path.join(__dirname, "..", "Public")));

app.use("/api/v1/user", userRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/auto", autoRouter);
app.use("/api/v1/public", publicRouter);

//TODO: Better 404 handling maybe
app.use((req, res, next) =>
  res.status(404).json({ message: "این مسیر وجود ندارد" })
);

app.use(errorController);

export default app;
