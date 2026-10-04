import { NextFunction, Request, Response, RequestHandler } from "express";
import AppError from "../../AppError";
import { OwnerOf } from "../../../Controllers/businessController";

// What each provider profile gets of the CRM's engagement and service side
// (2026-10), mirrored by the frontend's Crm/Service/profiles.ts: Nexxa is
// the source, each profile takes what fits its work. An insurer has no
// loyalty club, no returns and no clinical checklists.
export type ServicePart = "club" | "sequences" | "flows" | "tickets" | "tasks" | "timesheet" | "calendar" | "checklists" | "knowledge" | "quizzes" | "returns";

const OFF: Record<string, ServicePart[]> = {
  insurance: ["club", "returns", "checklists"],
};

export const partOn = (kind: string, part: ServicePart) => !(OFF[kind] || []).includes(part);

// a route guard: this part is not for this profile
export const onlyFor =
  (ownerOf: OwnerOf, part: ServicePart): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    // runs before the panel's access middleware: the profile is the
    // panel's kind (OwnerOf.kind), not the not-yet-resolved owner
    const kind = ownerOf.kind || ownerOf(req)?.kind;
    if (kind && !partOn(kind, part)) return next(new AppError("این بخش برای این نوع حساب نیست", 400));
    next();
  };
