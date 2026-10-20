import crypto from "crypto";
import fs from "fs";
import path from "path";
import { sniffExtension } from "../Controllers/uploadController";
import { safeFetch } from "./safeFetch";

// Files of the old site (images of doctors, articles, diseases, ...) during
// the old-site import (Services/oldSiteImport.ts). The new site stores a
// path relative to Public/ and serves it at /files/<path>.
//
// - A relative path ("uploads/a.jpg", "/a.jpg") is kept as the same
//   relative path. When the file is not in Public/ yet and a files base URL
//   is given (OLD_FILES_BASE_URL, e.g. https://noyanai.com/files), it is
//   downloaded from <base>/<path> into Public/<path>. Without a base URL the
//   path is kept, so copying the old upload folder into Public/ (rsync, see
//   deploy/README.md) makes it work later.
// - An absolute URL on another host is downloaded into Public/legacy/; when
//   that fails the URL is kept as it is (the site shows absolute URLs as
//   they are).
// A failed download never fails the row: the value is kept and counted.
// Security: the URLs come from imported data, so they are fetched through
// Lib/safeFetch.ts (public internet only, every redirect checked, size and
// time capped), and what lands in Public/ (served to every visitor) must be
// one of SAFE_EXTS by its bytes - never HTML/SVG/JS a browser would run.

export type OldFilesOptions = {
  baseUrl?: string;
  download: boolean;
  publicDir?: string;
  // origins that are this site itself (FILE_PATH): their URLs become relative
  ownOrigins?: string[];
};

export type OldFilesStats = {
  kept: number;
  downloaded: number;
  present: number;
  failed: number;
  failures: string[];
};

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const CONCURRENCY = 6;
const MAX_FAILURES_LISTED = 30;

const isAbsolute = (v: string) => /^https?:\/\//i.test(v);

// what may be written into Public/: by the file's real bytes (sniffExtension)
// and by the name it is served under (express.static picks the type from it)
const SAFE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "pdf", "mp4", "webm", "mp3", "wav", "ogg"]);
// a ".jpg" that is really a PNG still shows: only the kind has to agree
const KIND: Record<string, string> = {
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  pdf: "pdf", mp4: "video", webm: "video", mp3: "audio", wav: "audio", ogg: "audio",
};
const safeExtOf = (p: string) => {
  const e = path.extname(p).slice(1).toLowerCase();
  return SAFE_EXTS.has(e) ? e : undefined;
};

// a stored relative path, made safe to join under Public/
const cleanRelative = (raw: string): string | undefined => {
  let v = raw.split(/[?#]/)[0].replace(/\\/g, "/");
  try {
    v = decodeURIComponent(v);
  } catch {
    /* keep as is */
  }
  const parts = v.split("/").filter((p) => p && p !== "." && p !== "..");
  if (!parts.length) return undefined;
  return parts.join("/");
};

// the name's extension when it is a safe one (the bytes are checked after)
const extOf = (url: string) => {
  const e = safeExtOf(new URL(url).pathname);
  return e ? `.${e}` : "";
};

export const createOldFiles = (options: OldFilesOptions) => {
  const publicDir = options.publicDir || path.join(process.cwd(), "Public");
  const baseUrl = options.baseUrl?.replace(/\/+$/, "");
  const ownOrigins = (options.ownOrigins || []).map((o) => o.replace(/\/+$/, ""));
  const stats: OldFilesStats = { kept: 0, downloaded: 0, present: 0, failed: 0, failures: [] };
  const memo = new Map<string, Promise<string | undefined>>();

  let active = 0;
  const waiting: (() => void)[] = [];
  const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };

  const fail = (what: string, why: string) => {
    stats.failed++;
    if (stats.failures.length < MAX_FAILURES_LISTED) stats.failures.push(`${what}: ${why}`);
  };

  // target without an extension: the sniffed one is added; with one, the
  // bytes must be of that kind. Returns the path written (relative).
  const download = (url: string, target: string) =>
    limited(async () => {
      const res = await safeFetch(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") || "";
      // a 200 page that is an HTML error page, not the file
      if (/text\/html/i.test(type)) throw new Error("got an HTML page");
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("empty file");
      if (buf.length > MAX_BYTES) throw new Error("file too large");
      const sniffed = sniffExtension(buf, "");
      if (!sniffed || !SAFE_EXTS.has(sniffed)) throw new Error("not an allowed file type");
      const wanted = safeExtOf(target);
      if (wanted && KIND[wanted] !== KIND[sniffed]) throw new Error("content does not match the file type");
      const rel = wanted ? target : `${target}.${sniffed}`;
      const full = path.join(publicDir, rel);
      if (!full.startsWith(publicDir + path.sep)) throw new Error("unsafe path");
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      const tmp = `${full}.part-${process.pid}`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, full);
      return rel;
    });

  const exists = (rel: string) => fs.existsSync(path.join(publicDir, rel));

  const resolveOne = async (raw: string): Promise<string | undefined> => {
    const value = raw.trim();
    if (!value || /^data:/i.test(value) || /^blob:/i.test(value)) return undefined;

    if (isAbsolute(value)) {
      const own = ownOrigins.find((o) => value.startsWith(o + "/"));
      if (own) return cleanRelative(value.slice(own.length)) || value;
      if (!options.download) {
        stats.kept++;
        return value;
      }
      let target: string;
      try {
        const hash = crypto.createHash("sha1").update(value).digest("hex").slice(0, 20);
        target = `legacy/${hash}${extOf(value)}`;
      } catch {
        fail(value, "bad URL");
        return value;
      }
      // an earlier run's copy (named by the URL's extension or the sniffed one)
      const earlier = path.extname(target) ? [target] : [...SAFE_EXTS].map((e) => `${target}.${e}`);
      const present = earlier.find(exists);
      if (present) {
        stats.present++;
        return present;
      }
      try {
        const written = await download(value, target);
        stats.downloaded++;
        return written;
      } catch (err) {
        fail(value, (err as Error).message);
        return value;
      }
    }

    const rel = cleanRelative(value);
    if (!rel) return undefined;
    if (exists(rel)) {
      stats.present++;
      return rel;
    }
    if (!baseUrl || !options.download) {
      stats.kept++;
      return rel;
    }
    // only a file a browser shows, never runs (no .html / .svg / .js)
    if (!safeExtOf(rel)) {
      fail(rel, "not an allowed file type");
      return rel;
    }
    const url = `${baseUrl}/${rel.split("/").map(encodeURIComponent).join("/")}`;
    try {
      await download(url, rel);
      stats.downloaded++;
    } catch (err) {
      fail(url, (err as Error).message);
    }
    return rel;
  };

  const resolve = (raw: unknown): Promise<string | undefined> => {
    if (typeof raw !== "string") return Promise.resolve(undefined);
    const key = raw.trim();
    if (!memo.has(key)) memo.set(key, resolveOne(key));
    return memo.get(key)!;
  };

  // a resolved value that will show: a file in Public/ or an absolute URL
  const available = (value: string) => isAbsolute(value) || exists(value);

  return { resolve, available, stats };
};

export type OldFiles = ReturnType<typeof createOldFiles>;
