import { IUser } from "./Models/User";

declare global {
  namespace Express {
    export interface Request {
      user?: IUser;
      doctor?: IDoctorProfile;
    }
  }
}

import app from "./app";
import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import * as env from "./Lib/Env";
import { IDoctorProfile } from "./Models/DoctorProfile";

let DB = `mongodb://${env.dbHost}:${env.dbPort}/${env.dbName}`;

if (env.DB_USERNAME && env.DB_PASSWORD)
  DB = `mongodb://${env.DB_USERNAME}:${env.DB_PASSWORD}@${env.dbHost}:${env.dbPort}/${env.dbName}?authSource=admin`;

const initiatePublicFolder = async () => {
  const pathToPublicFolder = path.join(process.cwd(), "Public");
  try {
    const stat = await fs.stat(pathToPublicFolder);
    if (!stat.isDirectory()) throw new Error();
  } catch {
    console.log("Public Folder Not Detected Creating One");
    try {
      await fs.mkdir(pathToPublicFolder);
    } catch (err) {
      console.log("There Was An Error Creating Public Folder:");
      console.log(err);
    }
  }
};

const init = async () => {
  await initiatePublicFolder();
};

init();

mongoose
  .connect(DB)
  .then(() => {
    console.log(`Database Connected Successfully`);
  })
  .catch((err) => {
    console.log("Database Connection Failed, Reason:");
    console.log(err);
  });

app.listen(env.port, () => {
  console.log(`Listening on port ${env.port}`);
});
