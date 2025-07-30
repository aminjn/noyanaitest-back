import express from "express";
import cookieParser from "cookie-parser";
import path from "path";

import errorController from "./Controllers/errorController";

import "./Models/BecomeDoctorRequest";
import "./Models/Blog";
import "./Models/BlogCategory";
import "./Models/BlogMedia";
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

const app = express();

app.use(cookieParser());

app.use(express.json());

app.use(express.static(path.join(__dirname, "..", "Public")));

app.use("/api/v1/user", userRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/auto", autoRouter);
app.use("/api/v1/public", publicRouter);
app.use("/api/v1/doctor", doctorRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/old", oldRouter);
app.use("/api/v1/migrate", migrationRouter);

//TODO: Better 404 handling maybe
app.use((req, res, next) =>
  res.status(404).json({ message: "این مسیر وجود ندارد" })
);

app.use(errorController);

export default app;
