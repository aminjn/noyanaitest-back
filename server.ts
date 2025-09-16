import { IUser } from "./Models/User";
import { createServer } from "http";

declare global {
  namespace Express {
    export interface Request {
      user?: IUser;
      doctor?: IDoctorProfile;
      insurance?: IInsurance;
      clinic?: IClinic;
      pharmacy?: IPharmacy;
    }
  }
}

declare module "socket.io" {
  interface Socket {
    user?: IUser | null;
  }
}

import app from "./app";
import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import * as env from "./Lib/Env";
import { IDoctorProfile } from "./Models/DoctorProfile";
import { IInsurance } from "./Models/Insurance";
import { IClinic } from "./Models/Clinic";
import { IPharmacy } from "./Models/Pharmacy";
import initSocket from "./socket/socket";
import CallRoom from "./Models/CallRoom";

let DB = `mongodb://${env.dbHost}:${env.dbPort}/${env.dbName}`;

if (env.DB_USERNAME && env.DB_PASSWORD)
  DB = `mongodb://${env.DB_USERNAME}:${env.DB_PASSWORD}@${env.dbHost}:${env.dbPort}/${env.dbName}?authSource=admin`;

const initiateFolders = async () => {
  const folders = ["Public", "NotPublic"];
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

const init = async () => {
  await initiateFolders();
  await CallRoom.deleteMany();
};

init();

const server = createServer(app);

const _io = initSocket(server);

export const io = _io;

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
