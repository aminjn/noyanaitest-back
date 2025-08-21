import { customAlphabet } from "nanoid";
import { NODE_ENV } from "./Env";
import * as z from "zod";
import { isPhone } from "./validators";
import * as Env from "./Env";

const nanoid = customAlphabet("0123456789", 6);

export const randomCode: () => string = () =>
  NODE_ENV === "development" ? "111111" : nanoid();

export const sendSMS = async (
  to: string,
  payload: { [key: string]: string },
  pattern: string | undefined
): Promise<boolean> => {
  console.log(payload);
  return true;
};

export const clamp = (min: number, val: number, max: number): number =>
  Math.min(max, Math.max(val, min));

export const sleep = async (dur: number) =>
  await new Promise((r) =>
    setTimeout(r, Env.NODE_ENV === "development" ? dur : 1)
  );

export const boolish = z.preprocess((val) => {
  if (typeof val === "string") {
    if (val === "true") return true;
    if (val === "false") return false;
  }
  return val;
}, z.boolean());

export const phonish = z.preprocess((val) => isPhone(val), z.string().min(1));

export const nullish = z.preprocess(
  (val) => (val === "null" ? null : val),
  z.string().optional().nullable()
);

export const getSessionDateKey = (date: Date): string =>
  new Date(date).toISOString().split("T")[0];

export const startOfTomorrow = () => {
  const then = new Date();
  then.setDate(then.getDate() - 1);
  then.setHours(0);
  then.setSeconds(0);
  then.setMinutes(0);
  then.setMilliseconds(0);
  return then;
};
