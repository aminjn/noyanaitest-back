import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Model } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import { userRoles } from "../Lib/enums";
import { isPhone } from "../Lib/validators";
import { userStatuses } from "../Models/User";
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
  status: z.enum(userStatuses).optional(),
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
    const { q, role, status, page, limit } = parsed.data;

    const filter: Record<string, unknown> = {};
    if (role) filter.role = role;
    // closed accounts only show when asked for
    filter.status = status ? (status === "active" ? { $in: ["active", null] } : status) : { $ne: "deleted" };
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

    const [items, total, roleCounts, statusCounts] = await Promise.all([
      User.find(filter)
        .sort({ _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("phone username role avatar status statusReason suspendedUntil")
        .populate({ path: "identity", select: "givenName lastName" }),
      User.countDocuments(filter),
      User.aggregate([
        { $match: { status: { $ne: "deleted" } } },
        { $group: { _id: "$role", count: { $sum: 1 } } },
      ]),
      User.aggregate([{ $group: { _id: { $ifNull: ["$status", "active"] }, count: { $sum: 1 } } }]),
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
            status: user.status || "active",
            statusReason: user.statusReason,
            suspendedUntil: user.suspendedUntil,
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
          statusCounts: Object.fromEntries(
            statusCounts.map((row: any) => [row._id, row.count]),
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
          status: user.status || "active",
          statusReason: user.statusReason,
          statusChangedAt: user.statusChangedAt,
          suspendedUntil: user.suspendedUntil,
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

// --- account management (2026-10, super admin "users" page) ---
// Doctolib Pro / Practo back offices let support create an account for a
// caller, fix its phone or name, suspend it (with a reason, optionally until
// a date) and close it. Closing never erases medical or money records: the
// account is anonymised and can't sign in again.

const displayNameSchema = z.string().trim().min(2).max(60);

const createSchema = z.strictObject({
  phone: z.string(),
  username: displayNameSchema.optional(),
});

// POST /admin/users
export const createUser: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError());
    const phone = isPhone(toAsciiDigits(parsed.data.phone));
    if (!phone) return next(new AppError("شماره موبایل معتبر نیست", 400));
    if (await User.exists({ phone }))
      return next(new AppError("کاربری با این شماره موبایل وجود دارد", 400));
    const user = await User.create({ phone, username: parsed.data.username });
    res.status(201).json({ message: "createUser", data: { data: { _id: user._id } } });
  },
);

const updateSchema = z.strictObject({
  username: z.union([displayNameSchema, z.literal("")]).optional(),
  phone: z.string().optional(),
});

// PATCH /admin/users/:nodeId - display name and phone. The phone is the
// login: changing it ends the user's sessions so the old number can't stay
// signed in.
export const updateUser: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const user = await User.findById(nodeId);
    if (!user || user.status === "deleted") return next(new NotFoundError());
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    if (parsed.data.username !== undefined) {
      if (parsed.data.username) $set.username = parsed.data.username;
      else $unset.username = 1;
    }
    let phoneChanged = false;
    if (parsed.data.phone !== undefined) {
      const phone = isPhone(toAsciiDigits(parsed.data.phone));
      if (!phone) return next(new AppError("شماره موبایل معتبر نیست", 400));
      if (phone !== user.phone) {
        if (await User.exists({ phone, _id: { $ne: user._id } }))
          return next(new AppError("کاربری با این شماره موبایل وجود دارد", 400));
        $set.phone = phone;
        phoneChanged = true;
      }
    }
    // phone is immutable in the schema (users can't change it themselves);
    // the admin change goes to the collection directly
    if (Object.keys($set).length || Object.keys($unset).length)
      await User.collection.updateOne(
        { _id: user._id },
        { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
      );
    if (phoneChanged)
      await UserSecurity.findOneAndUpdate(
        { user: user._id },
        { user: user._id, lastLogin: new Date() },
        { upsert: true },
      );
    res.status(200).json({ message: "updateUser" });
  },
);

const statusSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("active") }),
  z.strictObject({
    status: z.literal("suspended"),
    reason: z.string().trim().min(3).max(500),
    until: z.coerce.date().optional(),
  }),
]);

// POST /admin/users/:nodeId/status - suspend (with a reason, optionally
// until a date) or reactivate. Suspending ends every session at once.
export const setUserStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    if (String(nodeId) === String(req.user?._id))
      return next(new AppError("نمی‌توانید حساب خودتان را تغییر دهید", 400));
    const user = await User.findById(nodeId);
    if (!user || user.status === "deleted") return next(new NotFoundError());
    if (parsed.data.status === "suspended") {
      if (user.role === "admin")
        return next(new AppError("سوپر ادمین را نمی‌توان معلق کرد؛ اول نقش او را تغییر دهید", 400));
      if (parsed.data.until && parsed.data.until <= new Date())
        return next(new AppError("تاریخ پایان تعلیق باید در آینده باشد", 400));
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            status: "suspended",
            statusReason: parsed.data.reason,
            statusChangedAt: new Date(),
            ...(parsed.data.until ? { suspendedUntil: parsed.data.until } : {}),
          },
          ...(parsed.data.until ? {} : { $unset: { suspendedUntil: 1 } }),
        },
      );
      await UserSecurity.findOneAndUpdate(
        { user: user._id },
        { user: user._id, lastLogin: new Date() },
        { upsert: true },
      );
    } else {
      await User.updateOne(
        { _id: user._id },
        { $set: { status: "active", statusChangedAt: new Date() }, $unset: { statusReason: 1, suspendedUntil: 1 } },
      );
    }
    res.status(200).json({ message: "setUserStatus" });
  },
);

// DELETE /admin/users/:nodeId - closes the account. Refused while it holds
// money or runs a provider panel (those need a settlement / a new owner
// first). Otherwise the phone, name and identity are removed and the
// account can't sign in; its visits, prescriptions, orders and payments
// stay, as medical and financial records must.
export const deleteUser: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    if (String(nodeId) === String(req.user?._id))
      return next(new AppError("نمی‌توانید حساب خودتان را حذف کنید", 400));
    const user = await User.findById(nodeId);
    if (!user || user.status === "deleted") return next(new NotFoundError());
    if (user.role !== "user")
      return next(new AppError("حساب ادمین یا کارمند را نمی‌توان حذف کرد؛ اول نقش او را به کاربر تغییر دهید", 400));
    const wallet = await Wallet.findOne({ user: user._id }).select("balance").lean();
    if ((wallet?.balance ?? 0) > 0)
      return next(new AppError("این کاربر موجودی کیف پول دارد؛ اول تسویه کنید", 400));
    for (const { model, title } of ownedProfiles)
      if (await model.exists({ user: user._id }))
        return next(new AppError(`این کاربر مالک پنل ${title} است؛ اول مالک پنل را عوض کنید`, 400));
    await User.collection.updateOne(
      { _id: user._id },
      {
        $set: {
          phone: `deleted-${user._id}`,
          status: "deleted",
          statusChangedAt: new Date(),
          statusReason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : undefined,
        },
        $unset: { username: 1, avatar: 1, nationalId: 1, locale: 1, suspendedUntil: 1 },
      },
    );
    await UserIdentity.deleteMany({ user: user._id });
    await UserSecurity.findOneAndUpdate(
      { user: user._id },
      { user: user._id, lastLogin: new Date() },
      { upsert: true },
    );
    res.status(200).json({ message: "deleteUser" });
  },
);

// POST /admin/users/:nodeId/identity/reset - removes the verified identity
// (a wrong person was verified, a name changed at Sabt Ahval); the user
// verifies again on next use.
export const resetUserIdentity: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const user = await User.findById(nodeId).select("_id status");
    if (!user || user.status === "deleted") return next(new NotFoundError());
    await UserIdentity.deleteMany({ user: user._id });
    await User.collection.updateOne({ _id: user._id }, { $unset: { nationalId: 1 } });
    res.status(200).json({ message: "resetUserIdentity" });
  },
);
