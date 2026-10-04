import crypto from "crypto";
import fs from "fs";
import path from "path";

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

const extOf = (url: string, contentType?: string | null) => {
  const fromUrl = path.extname(new URL(url).pathname).toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(fromUrl)) return fromUrl;
  const ct = (contentType || "").split(";")[0].trim();
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "video/mp4": ".mp4",
  };
  return map[ct] || "";
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

  const download = (url: string, target: string) =>
    limited(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get("content-type") || "";
        // a 200 page that is an HTML error page, not the file
        if (/text\/html/i.test(type)) throw new Error("got an HTML page");
        const declared = Number(res.headers.get("content-length") || 0);
        if (declared > MAX_BYTES) throw new Error("file too large");
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error("empty file");
        if (buf.length > MAX_BYTES) throw new Error("file too large");
        const full = path.join(publicDir, target);
        if (!full.startsWith(publicDir + path.sep)) throw new Error("unsafe path");
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        const tmp = `${full}.part-${process.pid}`;
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, full);
        return { contentType: type };
      } finally {
        clearTimeout(timer);
      }
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
      if (exists(target)) {
        stats.present++;
        return target;
      }
      try {
        await download(value, target);
        stats.downloaded++;
        return target;
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
