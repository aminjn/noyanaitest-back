import { NextFunction, Request, RequestHandler, Response } from "express";
import fs from "fs";
import path from "path";
import catchAsync from "../Lib/catchAsync";
import { NotFoundError } from "../Lib/AppError";
import { OwnerOf } from "./businessController";
import { BIZ_FILE_RE, bizFilePrefix } from "./uploadController";

const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" };

// GET /<panel>/biz/finance/files/:file (2026-10): a private finance file
// (Controllers/uploadController.ts savePrivateBizFiles) read back by its own
// panel - the route's finance access is the ACL, the name's owner part must
// be this panel's. Anything else is "not found".
export const getFinanceFile = (ownerOf: OwnerOf): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    const name = String(req.params.file || "");
    const m = name.match(BIZ_FILE_RE);
    if (!owner || !m || !name.startsWith(bizFilePrefix(owner))) return next(new NotFoundError());
    const filePath = path.join(process.cwd(), "NotPublic", name);
    if (path.dirname(filePath) !== path.join(process.cwd(), "NotPublic") || !fs.existsSync(filePath)) return next(new NotFoundError());
    res.setHeader("Content-Type", MIME[m[3]] || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Disposition", `inline; filename="${name.replace(/^.*__/, "")}"`);
    fs.createReadStream(filePath).pipe(res);
  });
