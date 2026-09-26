import { NextFunction, Request, Response } from "express";
import { isValidObjectId } from "mongoose";
import AdminAuditLog, { AdminAuditAction } from "../Models/AdminAuditLog";

// Records every successful state-changing admin request once the response
// is sent. Mounted in app.ts on the admin-only routers, before them, so it
// runs for every request there; `req.user` is filled in later by `protect`
// and is read here only at "finish".
//
// Only field NAMES from the body are kept (settings pages carry API keys and
// passwords) plus a few whitelisted values such as the new role.

const MAX_FIELDS = 50;

// Admin GET routes that write (Tamin lookup syncs).
const isWritingGet = (path: string) => /^\/api\/v1\/admin\/tamin\/[^/]+$/.test(path);

export const classify = (
  base: string,
  method: string,
  segments: string[],
): { action: AdminAuditAction; target: string; targetId?: string } => {
  const [first = "", second, third] = segments;
  const id = second && isValidObjectId(second) ? second : undefined;
  switch (base) {
    case "auto":
      if (method === "PUT") return { action: "delete", target: first, targetId: id };
      if (second) return { action: "update", target: first, targetId: id };
      // POST /auto/<singleton> edits settings; POST /auto/<list> creates.
      return { action: "create", target: first };
    case "migrate":
      return { action: "migrate", target: first };
    case "ollama":
      return { action: "settings", target: `ollama/${first}`, targetId: id };
    default: // admin
      if (first === "users" && third === "role") return { action: "role", target: "user", targetId: id };
      if (first === "users" && third === "logout") return { action: "logout", target: "user", targetId: id };
      if (first === "tamin" && method === "GET") return { action: "sync", target: `tamin/${second}` };
      if (method === "PUT" && id) return { action: "update", target: first, targetId: id };
      return { action: "other", target: segments.filter((s) => !isValidObjectId(s)).join("/") || "admin" };
  }
};

// Singletons in the auto router are edited with POST /auto/<name>.
let singletonNames: Set<string> | null = null;
export const registerAuditSingletons = (names: string[]) => {
  singletonNames = new Set(names);
};

export const auditAdminActions =
  (base: "auto" | "admin" | "migrate" | "ollama") =>
  (req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    const path = req.originalUrl.split("?")[0];
    const writes = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    if (!writes && !(base === "admin" && isWritingGet(path))) return next();

    res.on("finish", () => {
      const user = req.user;
      if (!user || res.statusCode >= 400) return;
      if (user.role !== "admin" && user.role !== "notadmin") return;

      const segments = path.replace(new RegExp(`^/api/v1/${base}/?`), "").split("/").filter(Boolean);
      let { action, target, targetId } = classify(base, method, segments);
      if (base === "auto" && action === "create" && singletonNames?.has(target))
        action = "settings";

      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const fields = Object.keys(body).slice(0, MAX_FIELDS);
      const details: Record<string, unknown> = {};
      if (action === "role" && typeof body.role === "string") details.role = body.role;

      const forwarded = req.headers["x-forwarded-for"];
      const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0].trim() || req.socket.remoteAddress;

      AdminAuditLog.create({
        actor: user._id,
        actorRole: user.role,
        action,
        target,
        targetId,
        method,
        path,
        fields,
        details: Object.keys(details).length ? details : undefined,
        status: res.statusCode,
        ip,
      }).catch((err) => console.log("[audit] failed to write admin audit log:", err));
    });
    next();
  };
