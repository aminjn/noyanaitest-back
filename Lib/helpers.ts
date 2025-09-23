import { customAlphabet } from "nanoid";
import { NODE_ENV } from "./Env";
import * as z from "zod";
import { isPhone } from "./validators";
import * as Env from "./Env";
import { NOMEM } from "dns";

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

export const datish = z.preprocess((val) => {
  if (typeof val === "string") {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  }
  return val;
}, z.date());

export const numerish = (min: number, max: number) =>
  z.preprocess((val) => {
    if (typeof val === "string" && !isNaN(Number(val))) return Number(val);
    return val;
  }, z.number().min(min).max(max));

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

export const numberToTime = (val: number): string =>
  `${`${Math.floor(val / 60)}`.padStart(2, "0")}:${`${Math.floor(
    val % 60
  )}`.padStart(2, "0")}`;

export const isLng = z.number().min(-180).max(180);
export const isLat = z.number().min(-90).max(90);

export const isPoint = z.tuple([isLat, isLng]);
