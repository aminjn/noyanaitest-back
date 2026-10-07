import { NextFunction, Request, RequestHandler, Response } from "express";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import UserRelative from "../Models/UserRelative";
import UserIdentity from "../Models/UserIdentity";
import { describeInsurances, insuranceChoices, manageableIdentity, saveInsurances } from "../Lib/patientInsurances";

// «بیمه‌های من» (Lib/patientInsurances.ts): the patient's own insurances,
// and those of the family members they book for.

const id = z.string().regex(/^[0-9a-fA-F]{24}$/);

// GET /user/insurances?patient= - one person's saved insurances, the people
// this account may manage and the insurers to choose from
export const getMyInsurances: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const patient = typeof req.query.patient === "string" ? req.query.patient : null;
    const found = await manageableIdentity(req.user._id, patient);
    // no identity yet: the page asks to complete it first
    if (!found && !patient)
      return res.status(200).json({ message: "getMyInsurances", data: { patient: null, people: [], items: [], insurers: await insuranceChoices() } });
    if (!found) return next(new NotFoundError("بیمار"));
    const own = await UserIdentity.findOne({ user: req.user._id }).select("givenName lastName").lean();
    const relatives = await UserRelative.find({ user: req.user._id })
      .populate({ path: "other", select: "givenName lastName" })
      .lean<{ other?: { _id: unknown; givenName?: string; lastName?: string } | null }[]>();
    const name = (p?: { givenName?: string; lastName?: string } | null) => `${p?.givenName || ""} ${p?.lastName || ""}`.trim();
    const people = [
      ...(own ? [{ _id: String(own._id), name: name(own), self: true }] : []),
      ...relatives.filter((r) => r.other?._id).map((r) => ({ _id: String(r.other!._id), name: name(r.other), self: false })),
    ];
    res.status(200).json({
      message: "getMyInsurances",
      data: {
        patient: { _id: String(found.identity._id), name: name(found.identity), self: found.self },
        people,
        items: await describeInsurances(found.identity.insurances),
        insurers: await insuranceChoices(),
      },
    });
  },
);

const saveSchema = z.strictObject({
  patient: id.optional(),
  items: z
    .array(
      z.strictObject({
        insurance: id,
        plan: id.nullable().optional(),
        memberNumber: z.string().max(60).nullable().optional(),
        expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }),
    )
    .max(2),
});

// PUT /user/insurances {patient?, items} - the whole list (add, edit and
// remove are one save, like the address book)
export const saveMyInsurances: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const parsed = saveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    const found = await manageableIdentity(req.user._id, parsed.data.patient || null);
    if (!found) return next(new NotFoundError("بیمار"));
    const list = await saveInsurances(found.identity._id as never, parsed.data.items);
    res.status(200).json({ message: "saveMyInsurances", data: { items: await describeInsurances(list) } });
  },
);
