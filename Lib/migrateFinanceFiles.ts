import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import { bizFilePrefix } from "../Controllers/uploadController";

// Boot migration (2026-10): finance files (receipts, expense bills, voucher
// scans) used to be written to Public/ as finance__…, readable by anyone
// with the name. Each one an expense or a voucher points at moves to
// NotPublic/ under its owner's name (biz__<kind>-<id>__…) and the record is
// pointed at the new name, so the panel reads it through
// /<panel>/biz/finance/files/:file. A finance__ file nothing points at is
// moved out of Public/ too (kept, never served). Once (the marker).
const MARKER = "business-private-finance-files";
const LEGACY = /^finance__[\w-]+\.(jpg|png|webp|gif|pdf)$/;

export const migrateFinanceFiles = async () => {
  const db = mongoose.connection.db;
  if (!db) return;
  const marks = db.collection<{ _id: string; at: Date }>("bootmigrations");
  if (await marks.findOne({ _id: MARKER })) return;
  const pub = path.join(process.cwd(), "Public");
  const priv = path.join(process.cwd(), "NotPublic");
  await fs.mkdir(priv, { recursive: true });
  const moved = new Map<string, string>();
  let files = 0;
  const relocate = async (name: string, owner: { kind: string; id?: unknown }) => {
    if (!LEGACY.test(name)) return name;
    const target = `${bizFilePrefix(owner)}${name.replace(/\.[a-z]+$/, "")}.${name.split(".").pop()}`;
    const from = path.join(pub, name);
    const to = path.join(priv, target);
    if (!moved.has(target)) {
      // a file two records share is copied, the original removed at the end
      await fs.copyFile(from, to).catch(() => undefined);
      moved.set(target, name);
      files++;
    }
    return target;
  };
  const ownerOf = (d: { ownerKind?: string; ownerId?: unknown }) => ({ kind: String(d.ownerKind || "platform"), id: d.ownerId });
  const expenses = db.collection<{ _id: unknown; ownerKind?: string; ownerId?: unknown; attachment?: string }>("bizexpenses");
  for (const e of await expenses.find({ attachment: { $regex: "^finance__" } }).toArray()) {
    const next = await relocate(String(e.attachment), ownerOf(e));
    if (next !== e.attachment) await expenses.updateOne({ _id: e._id }, { $set: { attachment: next } });
  }
  const vouchers = db.collection<{ _id: unknown; ownerKind?: string; ownerId?: unknown; attachments?: string[] }>("bizvouchers");
  for (const v of await vouchers.find({ attachments: { $regex: "^finance__" } }).toArray()) {
    const list = await Promise.all((v.attachments || []).map((a) => relocate(String(a), ownerOf(v))));
    await vouchers.updateOne({ _id: v._id }, { $set: { attachments: list } });
  }
  // nothing may read a finance file from Public/ any more
  const left = (await fs.readdir(pub).catch(() => [] as string[])).filter((n) => LEGACY.test(n));
  for (const n of left) {
    if (![...moved.values()].includes(n)) await fs.copyFile(path.join(pub, n), path.join(priv, `bizorphan__${n}`)).catch(() => undefined);
    await fs.unlink(path.join(pub, n)).catch(() => undefined);
  }
  await marks.insertOne({ _id: MARKER, at: new Date() });
  console.log(`[business] ${files} finance files made private, ${left.length} removed from Public`);
};
