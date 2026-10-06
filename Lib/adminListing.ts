import { tehranYmd } from "./tehranTime";
import { Response } from "express";
import { z } from "zod";
import User from "../Models/User";
import UserIdentity from "../Models/UserIdentity";

// Shared bits of the super admin's server-paged money lists (2026-10):
// page/limit, a free-text user search and a CSV export of the current
// filter. Used by Controllers/adminFinanceController.ts and
// withdrawalController.adminListWithdrawals.

export const PAGE_MAX = 200;
// a CSV export walks the whole filter, but never more than this many rows
export const EXPORT_MAX = 20000;

export const pagingQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
  format: z.enum(["json", "csv"]).optional(),
  q: z.string().trim().max(100).optional(),
});

export type Paging = z.infer<typeof pagingQuery>;

// what a list query asks Mongo for: one page, or the export cap
export const pageWindow = ({ page, limit, format }: Paging) =>
  format === "csv"
    ? { skip: 0, limit: EXPORT_MAX }
    : { skip: (page - 1) * limit, limit };

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toAsciiDigits = (text: string) =>
  text
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

// Users whose phone (any spelling, Persian digits ok), username or identity
// name matches `q` - same rules as the users page search
// (adminUserController.listUsers). Capped: a search is for finding someone.
export const searchUserIds = async (q: string): Promise<string[]> => {
  const text = toAsciiDigits(q.trim());
  if (!text) return [];
  const pattern = new RegExp(escapeRegex(text), "i");
  const or: Record<string, unknown>[] = [{ username: pattern }];
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 3)
    or.push({ phone: new RegExp(escapeRegex(digits.replace(/^(98|0)/, ""))) });
  const identities = await UserIdentity.find({
    $or: [{ givenName: pattern }, { lastName: pattern }, { nationalId: pattern }],
    user: { $exists: true },
  })
    .select("user")
    .limit(500)
    .lean();
  if (identities.length)
    or.push({ _id: { $in: identities.map((i: any) => i.user) } });
  const users = await User.find({ $or: or }).select("_id").limit(500).lean();
  return users.map((u: any) => String(u._id));
};

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const text =
    value instanceof Date
      ? isNaN(value.getTime())
        ? ""
        : value.toISOString()
      : String(value);
  // formula injection guard: a cell starting with = + - @ is text to Excel
  const safe = /^[=+\-@]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// Sends rows as a UTF-8 CSV with a BOM, so Excel shows Persian text.
export const sendCsv = (
  res: Response,
  filename: string,
  header: string[],
  rows: unknown[][],
) => {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}-${tehranYmd()}.csv"`,
  );
  res.status(200).send(`﻿${body}`);
};

export const userCsvLabel = (u: any) =>
  !u ? "" : [u.username, u.phone].filter(Boolean).join(" / ");
