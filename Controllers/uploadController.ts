import { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import catchAsync from "../Lib/catchAsync";
import fs from "fs/promises";
import path from "path";
import { nanoid } from "nanoid";
import { BadInputError } from "../Lib/AppError";

const multerStorage = multer.memoryStorage();

// No limit was previously set, so `memoryStorage` would buffer an
// arbitrarily large request body entirely in RAM before anything else ran
// — a memory-exhaustion/DoS angle called out alongside AUDIT F-02.
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB per file
const MAX_FILES_PER_REQUEST = 10;

export const upload = multer({
  storage: multerStorage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_FILES_PER_REQUEST },
  // With `memoryStorage`, `file.buffer` isn't populated yet when Multer's
  // own `fileFilter` runs — only `mimetype`/`originalname` are, and both
  // are attacker-supplied request headers, not verified content. Real,
  // content-based validation happens in `saveUplaodsToBody` below, once the
  // actual bytes are available (see `sniffExtension`).
  fileFilter: (req, file, cb) => cb(null, true),
});

/**
 * Recognized file kinds, keyed by the extension that gets written to disk.
 * Each `matches` sniffs the real file bytes (magic numbers) — never the
 * client-declared mimetype or original filename — so a relabeled or
 * malicious upload can't pass as a safe type. Anything that matches none of
 * these is rejected outright. This deliberately excludes HTML/SVG/JS and
 * anything else that could be served back and executed/rendered by a
 * browser: `Public/` is served statically (`app.ts`) with no content-type
 * enforcement, which was the stored-XSS-via-upload vector in AUDIT F-02 /
 * `10_SECURITY_FINDINGS.md` Finding 10.1.
 */
const FILE_SIGNATURES: { ext: string; matches: (buf: Buffer) => boolean }[] = [
  {
    ext: "jpg",
    matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "png",
    matches: (b) =>
      b.length >= 8 &&
      b
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: "gif",
    matches: (b) =>
      b.length >= 6 &&
      (b.toString("ascii", 0, 6) === "GIF87a" ||
        b.toString("ascii", 0, 6) === "GIF89a"),
  },
  {
    ext: "webp",
    matches: (b) =>
      b.length >= 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
  {
    ext: "pdf",
    matches: (b) => b.length >= 5 && b.toString("ascii", 0, 5) === "%PDF-",
  },
  {
    ext: "mp4",
    matches: (b) => b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp",
  },
  {
    ext: "webm",
    matches: (b) =>
      b.length >= 4 &&
      b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  },
  {
    ext: "mp3",
    matches: (b) =>
      b.length >= 3 &&
      (b.toString("ascii", 0, 3) === "ID3" ||
        (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)),
  },
  {
    ext: "wav",
    matches: (b) =>
      b.length >= 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WAVE",
  },
  {
    ext: "ogg",
    matches: (b) => b.length >= 4 && b.toString("ascii", 0, 4) === "OggS",
  },
  {
    // Legacy (pre-2007) Office formats: doc/xls/ppt all share this OLE
    // container signature.
    ext: "doc",
    matches: (b) =>
      b.length >= 8 &&
      b
        .subarray(0, 8)
        .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
  },
  {
    // Modern (zip-based) Office formats: docx/xlsx/pptx all share the same
    // "PK.." zip signature — see ZIP_OFFICE_EXTS below for how the specific
    // extension is picked.
    ext: "docx",
    matches: (b) =>
      b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] <= 0x08,
  },
];

// The zip signature alone can't distinguish docx/xlsx/pptx. The
// client-declared extension is trusted only to pick *which* of these
// equally zip-shaped, equally safe types to label the file as — never as
// the sole basis for accepting the upload in the first place.
const ZIP_OFFICE_EXTS = new Set(["docx", "xlsx", "pptx"]);

export const sniffExtension = (buf: Buffer, declaredExt: string): string | null => {
  for (const sig of FILE_SIGNATURES) {
    if (!sig.matches(buf)) continue;
    if (sig.ext === "docx" && ZIP_OFFICE_EXTS.has(declaredExt)) {
      return declaredExt;
    }
    return sig.ext;
  }
  return null;
};

export const saveUplaodsToBody: (args: { name: string }) => RequestHandler = ({
  name,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (Array.isArray(req.files) && !!req.files.length) {
      const publicDir = path.join(process.cwd(), "Public");
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];

        // The original filename (and therefore its "extension") is fully
        // attacker-controlled and was previously interpolated straight into
        // the on-disk path — `path.join()` normalizes `..` segments, so a
        // crafted filename could write outside `Public/` entirely. It's now
        // used only as a hint for which safe, sniffed extension to prefer
        // among equally-shaped formats (see ZIP_OFFICE_EXTS); the extension
        // actually written is always one of the fixed values in
        // FILE_SIGNATURES, never a raw string derived from user input.
        const declaredExt = (file.originalname.split(".").pop() || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");

        const ext = sniffExtension(file.buffer, declaredExt);
        if (!ext) {
          return next(new BadInputError("نوع فایل ارسال شده مجاز نیست"));
        }

        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const safeField = file.fieldname.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filename = `${safeName}__${safeField}__${Date.now()}_${nanoid(8)}.${ext}`;
        const filePath = path.join(publicDir, filename);

        // Defense in depth: `filename` is now built entirely from
        // sanitized/allowlisted parts, but confirm the resolved path still
        // lands inside Public/ before writing, in case that ever changes.
        if (path.dirname(filePath) !== publicDir) {
          return next(new BadInputError("مسیر فایل نامعتبر است"));
        }

        await fs.writeFile(filePath, file.buffer);
        req.body[file.fieldname] = filename;
      }
    }
    next();
  });
