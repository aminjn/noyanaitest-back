import { customAlphabet } from "nanoid";
import { NODE_ENV } from "./Env";
import * as z from "zod";
import { isPhone } from "./validators";
import * as Env from "./Env";
import { NOMEM } from "dns";
import { addTehranDays, tehranYmd } from "./tehranTime";

const nanoid = customAlphabet("0123456789", 6);

export const randomCode: () => string = () =>
  NODE_ENV === "development" ? "111111" : nanoid();

export const clamp = (min: number, val: number, max: number): number =>
  Math.min(max, Math.max(val, min));

export const sleep = async (dur: number) =>
  await new Promise((r) =>
    setTimeout(r, Env.NODE_ENV === "development" ? dur : 1),
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
  z.string().optional().nullable(),
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

// F-19 fix, then (2026-10) Tehran time: the day key of a DoctorSession is
// the Tehran calendar day ("YYYY-MM-DD"), whatever the server's zone - it
// used to read the server's local day (UTC on a server without TZ set, so
// evenings after 20:30 Tehran fell on the next day). Lib/tehranTime.ts.
export const getSessionDateKey = (date: Date): string => tehranYmd(date);

// yesterday's Tehran midnight plus one second (what the legacy calendar
// endpoints have always used as their lower bound)
export const startOfTomorrow = () => new Date(addTehranDays(new Date(), -1).getTime() + 1000);

export const numberToTime = (val: number): string =>
  `${`${Math.floor(val / 60)}`.padStart(2, "0")}:${`${Math.floor(
    val % 60,
  )}`.padStart(2, "0")}`;

export const isLng = z.number().min(-180).max(180);
export const isLat = z.number().min(-90).max(90);

export const isPoint = z.tuple([isLat, isLng]);

const alpahbet =
  "~_-." +
  "0123456789" +
  "abcdefghijklmnopqrstuvwxyz" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const createCodeVerifier = customAlphabet(alpahbet, 64);

export const toCodeChallenge = async (codeVerifier: string) => {
  const data = new TextEncoder().encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const escapeRegex = (str: string) =>
  str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const commentableSortOptions = [
  "best",
  "worst",
  "newest",
  "oldest",
] as const;

export type CommentableSortOption = (typeof commentableSortOptions)[number];

export const defaultCommentableSort: CommentableSortOption = "newest";

/**
 * Builds a mongo sort object for list endpoints of resources that carry
 * averageScore/commentCount (see commentableDocumentPaths in Models/Comment).
 *
 * - "best"/"worst": averageScore, then order, then _id as the final tiebreaker.
 * - "newest"/"oldest": order, then _id as the final tiebreaker.
 *
 * "best" and "newest" sort descending (highest score / latest first), while
 * "worst" and "oldest" sort ascending, and every key in the object shares the
 * same direction.
 */
export const buildCommentableSort = (
  sort: CommentableSortOption,
): Record<string, 1 | -1> => {
  const direction: 1 | -1 = sort === "best" || sort === "newest" ? -1 : 1;
  const keys =
    sort === "best" || sort === "worst"
      ? ["averageScore", "order", "_id"]
      : ["order", "_id"];
  return keys.reduce(
    (acc, key) => {
      acc[key] = direction;
      return acc;
    },
    {} as Record<string, 1 | -1>,
  );
};
