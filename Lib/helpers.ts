import { customAlphabet } from "nanoid";
import { NODE_ENV } from "./Env";

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
  await new Promise((r) => setTimeout(r, dur));
