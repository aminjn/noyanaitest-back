import express, { Router } from "express";
import cookieParser from "cookie-parser";
import path from "path";

import errorController from "./Controllers/errorController";

import "./Models/BecomeDoctorRequest";
import "./Models/Blog";
import "./Models/BlogCategory";
import "./Models/BlogMedia";
import "./Models/Booking";
import "./Models/Comment";
import "./Models/Doctor";
import "./Models/DoctorFeedback";
import "./Models/DoctorPhoneConsultSettings";
import "./Models/DoctorProfile";
import "./Models/InlineAdvertisement";
import "./Models/PatiantProfile";
import "./Models/PatientProfileDocument";
import "./Models/PendingUser";
import "./Models/Speciality";
import "./Models/TextContent";
import "./Models/Token";
import "./Models/TreatmentPlan";
import "./Models/TreatmentPlanStage";
import "./Models/User";
import "./Models/UserSecurity";

//OLD
import "./Models/Old/oldDoctor";
import "./Models/Old/oldSpeciality";
import "./Models/Old/oldUser";

import userRouter from "./Routers/userRouter";
import authRouter from "./Routers/authRouter";
import autoRouter from "./Routers/autoRouter";
import publicRouter from "./Routers/publicRouter";
import doctorRouter from "./Routers/doctorRouter";
import adminRouter from "./Routers/adminRouter";
import oldRouter from "./Routers/oldRouter";
import migrationRouter from "./Routers/migrationRouter";
import financeRouter from "./Routers/financeRouter";
import secretaryRouter from "./Routers/secretaryRouter";
import bookingRouter from "./Routers/bookingRouter";
import checkoutRouter from "./Routers/checkoutRouter";
import notPublicRouter from "./Routers/notPublicRouter";
import chatRouter from "./Routers/chatRouter";
import insuraceRourer from "./Routers/insuranceRouter";
import clinicRouter from "./Routers/clinicRouter";
import pharmacyRouter from "./Routers/pharmacyRouter";
import aclRouter from "./Routers/aclRouter";
import callRouter from "./Routers/callRouter";
import commentRouter from "./Routers/commentRouter";

import { PathNotFoundError } from "./Lib/AppError";
import { nodesWithAcl, NodeWithAcl } from "./Controllers/aclController";

const nameToRouter: Record<NodeWithAcl, Router> = {
  clinic: clinicRouter,
  pharmacy: pharmacyRouter,
  doctor: doctorRouter,
  insurance: insuraceRourer,
};

const app = express();

app.use(cookieParser());

app.use(express.json());

app.use(express.static(path.join(__dirname, "..", "Public")));

// app.use(async (req, res, next) => {
//   await new Promise((r) => setTimeout(r, 2000));
//   next();
// });

app.use("/api/v1/user", userRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/auto", autoRouter);
app.use("/api/v1/public", publicRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/old", oldRouter);
app.use("/api/v1/migrate", migrationRouter);
app.use("/api/v1/finance", financeRouter);
app.use("/api/v1/secretary", secretaryRouter);
app.use("/api/v1/booking", bookingRouter);
app.use("/api/v1/checkout", checkoutRouter);
app.use("/api/v1/notpublic", notPublicRouter);
app.use("/api/v1/chat", chatRouter);
app.use("/api/v1/call", callRouter);
app.use("/api/v1/comment", commentRouter);
app.use("/api/v1/acl/:name", aclRouter);

app.use("/api/v1/:name", (req, res, next) => {
  const name = nodesWithAcl.find((n) => n === req.params.name);
  if (!name) return next(new PathNotFoundError());
  return nameToRouter[name](req, res, next);
});

//TODO: Better 404 handling maybe
app.use((req, res, next) =>
  res.status(404).json({ message: "این مسیر وجود ندارد" }),
);

app.use(errorController);

export default app;

//TODO: Admin Page is not going 404 throughly on sub path wrong key
