import { IUser } from "./Models/User";
import { createServer } from "http";
import { Server as ioServer } from "socket.io";

declare global {
  namespace Express {
    export interface Request {
      user?: IUser;
      doctor?: IDoctorProfile;
      insurance?: IInsurance;
      clinic?: IClinic;
      pharmacy?: IPharmacy;
      paraClinic?: IParaClinic;
    }
  }
}

declare module "socket.io" {
  interface Socket {
    user?: IUser | null;
    inCall?: boolean;
  }
}

import app from "./app";
import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import * as env from "./Lib/Env";
import { getAppConfig } from "./Lib/appConfig";
import DoctorProfile, { IDoctorProfile } from "./Models/DoctorProfile";
import { IInsurance } from "./Models/Insurance";
import { IClinic } from "./Models/Clinic";
import { IPharmacy } from "./Models/Pharmacy";
import { initCallService } from "./Services/Call";
import {
  generateMissingSlugs,
  startSlugGenerationJob,
} from "./Services/slugGenerationService";
import {
  runReservationActivationSweep,
  startReservationActivationJob,
  runReservationReminderSweep,
  startReservationReminderJob,
  runReservationFinalizationSweep,
  startReservationFinalizationJob,
} from "./Services/reservationActivationService";

let DB = `mongodb://${env.dbHost}:${env.dbPort}/${env.dbName}`;

if (env.DB_USERNAME && env.DB_PASSWORD)
  DB = `mongodb://${env.DB_USERNAME}:${env.DB_PASSWORD}@${env.dbHost}:${env.dbPort}/${env.dbName}?authSource=admin`;

const initiateFolders = async () => {
  const folders = ["Public", "NotPublic", env.CALL_RECORDING_DIR];
  for (let i = 0; i < folders.length; ++i) {
    const pathToFolder = path.join(process.cwd(), folders[i]);
    try {
      const stat = await fs.stat(pathToFolder);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      console.log(`${folders[i]} Folder Not Detected Creating One`);
      try {
        await fs.mkdir(pathToFolder);
      } catch (err) {
        console.log(`There Was An Error Creating ${folders[i]} Folder:`);
        console.log(err);
      }
    }
  }
};

const recalculateAvailabilities = async () => {
  const { bookingHorizonDays } = await getAppConfig();
  const allDoctors = await DoctorProfile.find();
  const now = new Date();
  const lastDay = new Date();
  lastDay.setDate(lastDay.getDate() + bookingHorizonDays);
  for (const doctor of allDoctors) {
    await updateDoctorAvailability({
      doctor,
      startDate: now,
      endDate: lastDay,
    });
  }
};

const cleanUpExpiredDoctorAvailabilities = async () => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  await DoctorAvailability.deleteMany({ date: { $lt: now } });
};

const startDoctorAvailabilityCron = async () => {
  const { recalculateDoctorAvailabilityInterval } = await getAppConfig();
  setInterval(async () => {
    await cleanUpExpiredDoctorAvailabilities();
    await recalculateAvailabilities();
  }, recalculateDoctorAvailabilityInterval);
};

// Background-job intervals (below) are only read from AppConfig once, here
// at boot, to configure each setInterval - changing them from the admin
// settings page takes effect on the next server restart, not live. Values
// read per-request/per-tick elsewhere (SIP creds, Podium keys,
// bookingHorizonDays, reservationReminderMinutesBefore, ...) do update
// immediately, since those call getAppConfig() fresh each time.
const init = async () => {
  await initiateFolders();
  await cleanUpExpiredDoctorAvailabilities();
  await recalculateAvailabilities();
  await startDoctorAvailabilityCron();
  await generateMissingSlugs();
  const {
    slugGenerationInterval,
    reservationReminderInterval,
    reservationActivationInterval,
    reservationFinalizationInterval,
  } = await getAppConfig();
  startSlugGenerationJob(slugGenerationInterval);
  await runReservationReminderSweep();
  startReservationReminderJob(reservationReminderInterval);
  await runReservationActivationSweep();
  startReservationActivationJob(reservationActivationInterval);
  await runReservationFinalizationSweep();
  startReservationFinalizationJob(reservationFinalizationInterval);
};

init();

const server = createServer(app);

let _io: ioServer | null = null;

initCallService(server)
  .then((io) => {
    _io = io;
  })
  .catch((err) => {
    console.log("Failed to start call service (mediasoup/socket.io):");
    console.log(err);
  });

// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import ARI from "ari-client";

import https from "https";
import WebSocket from "ws";
import { IParaClinic } from "./Models/Paraclinic";
import updateDoctorAvailability from "./Lib/updateDoctorAvailablity";
import DoctorAvailability from "./Models/DoctorAvailability";

// const listenForCall = async () => {
//   console.log("start");
//   console.log({
//     SIP_HOST: env.SIP_HOST,
//     uname: env.SIP_USERNAME,
//     pwd: env.SIP_PASSWORD,
//   });

//   try {
//     const client = await ARI.connect(
//       env.SIP_HOST,
//       env.SIP_USERNAME,
//       env.SIP_PASSWORD,
//     );
//     console.log("Sip connected");

//     client.start("ai-agent");

//     client.on("StasisStart", async (event, channel) => {
//       console.log("Call entered AI agent:", channel.id);

//       await channel.play({
//         media: "sound:i-love-you",
//       });
//     });
//     client.on("WebSocketConnected", () => {
//       console.log("WS connected");
//     });

//     client.on("WebSocketReconnecting", () => {
//       console.log("WS reconnecting");
//     });

//     client.on("WebSocketMaxRetries", () => {
//       console.log("WS max retries");
//     });

//     // client.on("ApplicationRegistered", (e) => {
//     //   console.log("registered", e);
//     // });

//     // client.on("ApplicationUnregistered", (e) => {
//     //   console.log("unregistered", e);
//     // });
//   } catch (err) {
//     console.log({ err });
//   }
// };

// listenForCall();

export const io: ioServer | null = _io;

mongoose
  .connect(DB)
  .then(() => {
    console.log(`Database Connected Successfully`);
  })
  .catch((err) => {
    console.log("Database Connection Failed, Reason:");
    console.log(err);
  });

server.listen(env.port, () => {
  console.log(`Listening on port ${env.port}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection - exiting process:");
  console.error(reason);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception - exiting process:");
  console.error(err);
  process.exit(1);
});
