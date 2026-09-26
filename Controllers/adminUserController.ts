import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Model } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import { userRoles } from "../Lib/enums";
import User from "../Models/User";
import UserIdentity from "../Models/UserIdentity";
import UserSecurity from "../Models/UserSecurity";
import UserAccessLevel from "../Models/UserAccessLevel";
import AccessLevel from "../Models/AccessLevel";
import Wallet from "../Models/Wallet";
import Order from "../Models/Order";
import Reservation from "../Models/Reservation";
import DoctorProfile from "../Models/DoctorProfile";
import Clinic from "../Models/Clinic";
import Pharmacy from "../Models/Pharmacy";
import Hospital from "../Models/Hospital";
import Insurance from "../Models/Insurance";
import ParaClinic from "../Models/Paraclinic";

const MAX_LIMIT = 100;
const IDENTITY_MATCH_LIMIT = 500;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Persian/Arabic digits -> ASCII, so "۰۹۱۲" searches like "0912".
const toAsciiDigits = (text: string) =>
  text
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(userRoles).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(25),
});

// GET /admin/users?q=&role=&page=&limit=
// Server-side search + pagination (the generic /auto/user loads every user).
// q matches phone (any format, Persian digits ok), username, identity name
// or national id.
export const listUsers: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const { q, role, page, limit } = parsed.data;

    const filter: Record<string, unknown> = {};
    if (role) filter.role = role;
    if (q) {
      const text = toAsciiDigits(q);
      const pattern = new RegExp(escapeRegex(text), "i");
      const or: Record<string, unknown>[] = [{ username: pattern }];
      const digits = text.replace(/\D/g, "");
      if (digits.length >= 3) {
        // Stored as 98XXXXXXXXXX; "0912..." and "912..." both match.
        const local = digits.replace(/^(98|0)/, "");
        or.push({ phone: new RegExp(escapeRegex(local)) });
      }
      const identities = await UserIdentity.find({
        $or: [{ givenName: pattern }, { lastName: pattern }, { nationalId: pattern }],
        user: { $exists: true },
      })
        .select("user")
        .limit(IDENTITY_MATCH_LIMIT)
        .lean();
      if (identities.length)
        or.push({ _id: { $in: identities.map((i: any) => i.user) } });
      filter.$or = or;
    }

    const [items, total, roleCounts] = await Promise.all([
      User.find(filter)
        .sort({ _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("phone username role avatar")
        .populate({ path: "identity", select: "givenName lastName" }),
      User.countDocuments(filter),
      User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
    ]);

    res.status(200).json({
      message: "listUsers",
      data: {
        data: {
          items: items.map((user: any) => ({
            _id: user._id,
            phone: user.phone,
            username: user.username,
            role: user.role,
            name: user.identity
              ? `${user.identity.givenName} ${user.identity.lastName}`
              : undefined,
            createdAt: user._id.getTimestamp(),
          })),
          total,
          page,
          limit,
          roleCounts: Object.fromEntries(
            roleCounts.map((row: any) => [row._id, row.count]),
          ),
        },
      },
    });
  },
);

const ownedProfiles: { key: string; title: string; href: string; model: Model<any>; label: (doc: any) => string }[] = [
  { key: "doctorProfile", title: "پروفایل پزشک", href: "doctorprofile", model: DoctorProfile, label: (d) => [d.firstName, d.lastName].filter(Boolean).join(" ") },
  { key: "clinic", title: "کلینیک", href: "clinic", model: Clinic, label: (d) => d.name },
  { key: "hospital", title: "بیمارستان", href: "hospital", model: Hospital, label: (d) => d.name },
  { key: "pharmacy", title: "داروخانه", href: "pharmacy", model: Pharmacy, label: (d) => d.name },
  { key: "paraClinic", title: "پاراکلینیک", href: "paraClinic", model: ParaClinic, label: (d) => d.name },
  { key: "insurance", title: "بیمه", href: "insurance", model: Insurance, label: (d) => d.name },
];

// GET /admin/users/:nodeId
export const getUser: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const user = await User.findById(nodeId).populate({
      path: "identity",
      select: "givenName lastName nationalId gender dateOfbirth fatherName birthPlace",
    });
    if (!user) return next(new NotFoundError());

    const [security, access, wallet, reservations, orders, profiles] =
      await Promise.all([
        UserSecurity.findOne({ user: user._id }).lean(),
        UserAccessLevel.findOne({ user: user._id })
          .populate({ path: "accessLevel", select: "name" })
          .lean(),
        Wallet.findOne({ user: user._id }).select("balance").lean(),
        Reservation.countDocuments({ user: user._id }),
        Order.countDocuments({ user: user._id }),
        Promise.all(
          ownedProfiles.map(async ({ key, title, href, model, label }) => {
            const docs = await model.find({ user: user._id }).lean();
            return docs.map((doc: any) => ({
              key,
              title,
              href: `${href}/${doc._id}`,
              name: label(doc) || "بدون نام",
            }));
          }),
        ),
      ]);

    res.status(200).json({
      message: "getUser",
      data: {
        data: {
          _id: user._id,
          phone: user.phone,
          username: user.username,
          avatar: user.avatar,
          role: user.role,
          createdAt: user._id.getTimestamp(),
          identity: (user as any).identity || null,
          lastLogin: security?.lastLogin || null,
          accessLevel: (access as any)?.accessLevel || null,
          walletBalance: wallet?.balance ?? 0,
          counts: { reservations, orders },
          profiles: profiles.flat(),
          isSelf: String(user._id) === String(req.user?._id),
        },
      },
    });
  },
);

const roleSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("admin") }),
  z.object({ role: z.literal("user") }),
  z.object({
    role: z.literal("notadmin"),
    accessLevel: z.string().refine(isValidObjectId, "invalid accessLevel"),
  }),
]);

// PATCH /admin/users/:nodeId/role  (full admins only)
//   {role:"admin"}                      -> super admin
//   {role:"notadmin", accessLevel:id}   -> staff with that access level
//   {role:"user"}                       -> plain user, access level removed
// Admins can't change their own role, and the last admin can't be demoted.
export const setUserRole: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const body = parsed.data;
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    if (String(nodeId) === String(req.user?._id))
      return next(new AppError("نمی‌توانید نقش خودتان را تغییر دهید", 400));

    const user = await User.findById(nodeId);
    if (!user) return next(new NotFoundError());

    if (user.role === "admin" && body.role !== "admin") {
      const admins = await User.countDocuments({ role: "admin" });
      if (admins <= 1)
        return next(new AppError("حداقل یک سوپر ادمین باید باقی بماند", 400));
    }

    if (body.role === "notadmin") {
      const level = await AccessLevel.findById(body.accessLevel).select("_id");
      if (!level) return next(new NotFoundError());
      // The UserAccessLevel hooks skip admins, so set the role explicitly
      // after the assignment (covers demoting an admin to staff).
      await UserAccessLevel.findOneAndUpdate(
        { user: user._id },
        { user: user._id, accessLevel: level._id },
        { upsert: true },
      );
      await User.findByIdAndUpdate(user._id, { role: "notadmin" });
    } else {
      await User.findByIdAndUpdate(user._id, { role: body.role });
      // Access level only makes sense for notadmin; the delete hook would
      // demote to "user", so re-apply the requested role after it.
      const existing = await UserAccessLevel.findOne({ user: user._id });
      if (existing) {
        await UserAccessLevel.findByIdAndDelete(existing._id);
        await User.findByIdAndUpdate(user._id, { role: body.role });
      }
    }

    res.status(200).json({ message: "setUserRole" });
  },
);

// POST /admin/users/:nodeId/logout - invalidates every existing session of
// the user (protect rejects tokens issued before UserSecurity.lastLogin).
export const logoutUserEverywhere: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const user = await User.findById(nodeId).select("_id");
    if (!user) return next(new NotFoundError());
    await UserSecurity.findOneAndUpdate(
      { user: user._id },
      { user: user._id, lastLogin: new Date() },
      { upsert: true },
    );
    res.status(200).json({ message: "logoutUserEverywhere" });
  },
);
