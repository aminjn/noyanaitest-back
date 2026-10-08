import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { AccessError, BadInputError, MiddlewareError } from "../Lib/AppError";
import {
  activeCentreCookie,
  centreModel,
  MultiCentreKind,
  ownedCentres,
  resolveOwnedCentre,
  staffCentres,
} from "../Lib/activeCentre";
import Secretary from "../Models/Secretary";
import { cookieBuilder, cookieOptions, extractDataFromCookie } from "./authController";

// The centre switcher of the clinic / hospital panel (2026-10, one account
// can own several centres; Lib/activeCentre.ts). Lists the centres the
// account can open - its own, and those it works in as staff - and which
// one the panel shows now; switching to an own centre sets the active-centre
// cookie (and leaves "working on behalf of" mode), switching to a staff
// workplace sets the same workplace cookie the secretary panel sets.

type CentreRow = {
  _id: string;
  name?: string;
  image?: string;
  slug?: string;
  role: "owner" | "staff";
};

const idOf = (v: unknown) => (v && typeof v === "object" && "_id" in v ? String((v as { _id: unknown })._id) : v ? String(v) : "");

// the workplace (secretary) cookie, when it still points at a real link
const staffLinkOf = async (req: Request, res: Response, kind: MultiCentreKind) => {
  const cookie = req.cookies?.[kind];
  if (!cookie || !req.user) return null;
  const decoded = await extractDataFromCookie({ cookie, name: kind, res }).catch(() => undefined);
  const id = decoded && typeof decoded === "object" ? (decoded as { id?: unknown }).id : undefined;
  if (!id || !isValidObjectId(id)) return null;
  return Secretary.findOne({ _id: id, secretary: req.user._id }).select("owner").lean<{ owner?: unknown }>();
};

export const getMyCentres = (kind: MultiCentreKind): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const [owned, staff, link] = await Promise.all([
      ownedCentres(kind, req.user._id).select("name image slug").lean<{ _id: unknown; name?: string; image?: string; slug?: string }[]>(),
      staffCentres(kind, req.user._id).lean<{ owner?: { _id?: unknown; name?: string; image?: string; slug?: string } | null }[]>(),
      staffLinkOf(req, res, kind),
    ]);
    const rows: CentreRow[] = [
      ...(Array.isArray(owned) ? owned : []).map((c) => ({
        _id: String(c._id),
        name: c.name,
        image: c.image,
        slug: c.slug,
        role: "owner" as const,
      })),
      ...(Array.isArray(staff) ? staff : [])
        // a link whose centre was deleted, or one to a centre the account
        // also owns, is not listed twice
        .filter((s) => s.owner && s.owner._id && !owned.some((c) => String(c._id) === idOf(s.owner)))
        .map((s) => ({
          _id: idOf(s.owner),
          name: s.owner?.name,
          image: s.owner?.image,
          slug: s.owner?.slug,
          role: "staff" as const,
        })),
    ];
    let activeId = "";
    if (link?.owner) activeId = idOf(link.owner);
    else {
      const picked = await resolveOwnedCentre(kind, req.user._id, {
        cookie: req.cookies?.[activeCentreCookie[kind]],
      });
      if (!picked.denied && picked.centre) activeId = String(picked.centre._id);
    }
    res.status(200).json({ message: "getMyCentres", data: { centres: rows, activeId } });
  });

const switchSchema = z.object({ id: z.string() });

export const setMyActiveCentre = (kind: MultiCentreKind): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const parsed = switchSchema.safeParse(req.body ?? {});
    if (!parsed.success || !isValidObjectId(parsed.data.id)) return next(new BadInputError());
    const id = parsed.data.id;
    const own = await centreModel[kind].exists({ _id: id, user: req.user._id });
    if (own) {
      res.cookie(activeCentreCookie[kind], id, cookieOptions);
      // an own centre is never opened "on behalf of" someone
      if (req.cookies?.[kind]) res.clearCookie(kind, cookieOptions);
      return res.status(200).json({ message: "setMyActiveCentre", data: { activeId: id, role: "owner" } });
    }
    const link = await Secretary.findOne({
      secretary: req.user._id,
      owner: id,
      ownerPath: kind === "clinic" ? "Clinic" : "Hospital",
    }).select("_id");
    if (!link) return next(new AccessError());
    cookieBuilder({ name: kind, id: String(link._id), res });
    res.status(200).json({ message: "setMyActiveCentre", data: { activeId: id, role: "staff" } });
  });
