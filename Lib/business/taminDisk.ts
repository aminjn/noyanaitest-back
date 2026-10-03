import mongoose from "mongoose";
import moment from "moment-jalaali";
import BizPayrun, { IBizPayrun } from "../../Models/BizPayrun";
import BizEmployee, { IBizEmployee } from "../../Models/BizEmployee";
import BizPayrollSettings, { IBizPayrollSettings } from "../../Models/BizPayrollSettings";
import AppError from "../AppError";
import { BizOwner } from "./coa";
import { yearRules } from "./payroll";

// The Tamin monthly insurance list as the «دیسکت بیمه» the List Disk
// software and es.tamin.ir take (2026-10): DSKKAR00.DBF for the workshop
// and the month's totals, DSKWOR00.DBF for one row per insured person, in
// dBASE III, amounts in rials, Jalali dates as YYYYMMDD. Persian text in
// Iran System (the classic, visual-order code page the DOS-era software
// reads) or Windows-1256, set per workshop. Both files go out in one zip.

const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
const own = (o: BizOwner) => ({ ownerKind: o.kind, ownerId: oid(o.id) });
const rial = (toman: number) => Math.round((Number(toman) || 0) * 10);

// ------------------------------------------------------------ encodings

export const normalize = (s: string) =>
  (s || "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/[أإ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/‌/g, " ")
    .replace(/[ً-ْ]/g, "")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

const W1256: Record<string, number> = {
  "ء": 0xc1, "آ": 0xc2, "ئ": 0xc6, "ا": 0xc7, "ب": 0xc8, "پ": 0x81, "ت": 0xca, "ث": 0xcb, "ج": 0xcc, "چ": 0x8d,
  "ح": 0xcd, "خ": 0xce, "د": 0xcf, "ذ": 0xd0, "ر": 0xd1, "ز": 0xd2, "ژ": 0x8e, "س": 0xd3, "ش": 0xd4, "ص": 0xd5,
  "ض": 0xd6, "ط": 0xd8, "ظ": 0xd9, "ع": 0xda, "غ": 0xdb, "ف": 0xdd, "ق": 0xde, "ک": 0x98, "گ": 0x90, "ل": 0xe1,
  "م": 0xe3, "ن": 0xe4, "ه": 0xe5, "و": 0xe6, "ی": 0xed, "،": 0xa1, "؛": 0xba, "؟": 0xbf,
};

const toW1256 = (s: string) => {
  const out: number[] = [];
  for (const ch of normalize(s).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) out.push(c);
    else if (W1256[ch] !== undefined) out.push(W1256[ch]);
    else out.push(0x3f);
  }
  return Buffer.from(out);
};

// Iran System: one code for a letter alone or at a word's end, one when it
// joins the next letter (ع غ ه ی have more), stored in visual order
type Forms = { iso: number; fin?: number; ini?: number; med?: number };
const IS: Record<string, Forms> = {
  "آ": { iso: 0x8d },
  "ئ": { iso: 0xfe },
  "ء": { iso: 0x8f },
  "ا": { iso: 0x90, fin: 0x91 },
  "ب": { iso: 0x92, ini: 0x93 },
  "پ": { iso: 0x94, ini: 0x95 },
  "ت": { iso: 0x96, ini: 0x97 },
  "ث": { iso: 0x98, ini: 0x99 },
  "ج": { iso: 0x9a, ini: 0x9b },
  "چ": { iso: 0x9c, ini: 0x9d },
  "ح": { iso: 0x9e, ini: 0x9f },
  "خ": { iso: 0xa0, ini: 0xa1 },
  "د": { iso: 0xa2 },
  "ذ": { iso: 0xa3 },
  "ر": { iso: 0xa4 },
  "ز": { iso: 0xa5 },
  "ژ": { iso: 0xa6 },
  "س": { iso: 0xa7, ini: 0xa8 },
  "ش": { iso: 0xa9, ini: 0xaa },
  "ص": { iso: 0xab, ini: 0xac },
  "ض": { iso: 0xad, ini: 0xae },
  "ط": { iso: 0xaf },
  "ظ": { iso: 0xe0 },
  "ع": { iso: 0xe1, fin: 0xe2, med: 0xe3, ini: 0xe4 },
  "غ": { iso: 0xe5, fin: 0xe6, med: 0xe7, ini: 0xe8 },
  "ف": { iso: 0xe9, ini: 0xea },
  "ق": { iso: 0xeb, ini: 0xec },
  "ک": { iso: 0xed, ini: 0xee },
  "گ": { iso: 0xef, ini: 0xf0 },
  "ل": { iso: 0xf1, ini: 0xf3 },
  "م": { iso: 0xf4, ini: 0xf5 },
  "ن": { iso: 0xf6, ini: 0xf7 },
  "و": { iso: 0xf8 },
  "ه": { iso: 0xf9, med: 0xfa, ini: 0xfb },
  "ی": { iso: 0xfd, fin: 0xfc, ini: 0xfe },
};
const IS_PUNCT: Record<string, number> = { "،": 0x8a, "ـ": 0x8b, "؟": 0x8c };
// letters that join the one after them (the rest only join the one before)
const joinsNext = (ch?: string) => !!ch && !!IS[ch] && !!IS[ch].ini;
const isLetter = (ch?: string) => !!ch && !!IS[ch];

const toIranSystem = (s: string) => {
  const chars = [...normalize(s)];
  const glyphs: number[][] = []; // logical order; each entry one glyph run
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const prevJoins = joinsNext(chars[i - 1]) && isLetter(ch);
    if (ch === "ل" && chars[i + 1] === "ا") {
      glyphs.push([0xf2]);
      i++;
      continue;
    }
    const f = IS[ch];
    if (f) {
      const nextJoins = joinsNext(ch) && isLetter(chars[i + 1]);
      let code = f.iso;
      if (prevJoins && nextJoins) code = f.med ?? f.ini ?? f.iso;
      else if (nextJoins) code = f.ini ?? f.iso;
      else if (prevJoins) code = f.fin ?? f.iso;
      glyphs.push([code]);
      continue;
    }
    if (/[۰-۹]/.test(ch)) {
      glyphs.push([0x80 + "۰۱۲۳۴۵۶۷۸۹".indexOf(ch)]);
      continue;
    }
    if (IS_PUNCT[ch] !== undefined) {
      glyphs.push([IS_PUNCT[ch]]);
      continue;
    }
    const c = ch.charCodeAt(0);
    glyphs.push([c < 0x80 ? c : 0x3f]);
  }
  // visual order: right-to-left overall, a run of Latin letters or digits
  // kept left-to-right inside it
  const out: number[][] = [];
  let run: number[][] = [];
  const isLtr = (g: number[]) => (g[0] >= 0x30 && g[0] <= 0x39) || (g[0] >= 0x41 && g[0] <= 0x7a) || (g[0] >= 0x80 && g[0] <= 0x89);
  for (const g of glyphs) {
    if (isLtr(g)) run.push(g);
    else {
      if (run.length) out.push(...run.reverse());
      run = [];
      out.push(g);
    }
  }
  if (run.length) out.push(...run.reverse());
  return Buffer.from(out.reverse().flat());
};

// ------------------------------------------------------------------ DBF

type Field = { name: string; type: "C" | "N"; len: number };

const dbf = (fields: Field[], rows: (string | number)[][], encode: (s: string) => Buffer) => {
  const recLen = 1 + fields.reduce((s, f) => s + f.len, 0);
  const headLen = 32 + fields.length * 32 + 1;
  const now = new Date();
  const head = Buffer.alloc(32);
  head[0] = 0x03;
  head[1] = now.getFullYear() - 1900;
  head[2] = now.getMonth() + 1;
  head[3] = now.getDate();
  head.writeUInt32LE(rows.length, 4);
  head.writeUInt16LE(headLen, 8);
  head.writeUInt16LE(recLen, 10);
  const descs = fields.map((f) => {
    const d = Buffer.alloc(32);
    d.write(f.name.slice(0, 10), 0, "ascii");
    d[11] = f.type.charCodeAt(0);
    d[16] = f.len;
    d[17] = 0;
    return d;
  });
  const records = rows.map((row) => {
    const r = Buffer.alloc(recLen, 0x20);
    let at = 1;
    fields.forEach((f, i) => {
      const v = row[i];
      if (f.type === "N") {
        const text = String(Math.round(Number(v) || 0)).slice(-f.len);
        r.write(text.padStart(f.len, " "), at, "ascii");
      } else {
        const bytes = encode(String(v ?? "")).subarray(0, f.len);
        bytes.copy(r, at);
      }
      at += f.len;
    });
    return r;
  });
  return Buffer.concat([head, ...descs, Buffer.from([0x0d]), ...records, Buffer.from([0x1a])]);
};

const KAR: Field[] = [
  { name: "DSK_ID", type: "C", len: 10 },
  { name: "DSK_NAME", type: "C", len: 100 },
  { name: "DSK_FARM", type: "C", len: 100 },
  { name: "DSK_ADRS", type: "C", len: 100 },
  { name: "DSK_KIND", type: "N", len: 1 },
  { name: "DSK_YY", type: "N", len: 2 },
  { name: "DSK_MM", type: "N", len: 2 },
  { name: "DSK_LISTNO", type: "C", len: 12 },
  { name: "DSK_DISC", type: "C", len: 100 },
  { name: "DSK_NUM", type: "N", len: 5 },
  { name: "DSK_TDD", type: "N", len: 6 },
  { name: "DSK_TROOZ", type: "N", len: 12 },
  { name: "DSK_TMAH", type: "N", len: 12 },
  { name: "DSK_TMAZ", type: "N", len: 12 },
  { name: "DSK_TMASH", type: "N", len: 12 },
  { name: "DSK_TTOTL", type: "N", len: 12 },
  { name: "DSK_TBIME", type: "N", len: 12 },
  { name: "DSK_TKOSO", type: "N", len: 12 },
  { name: "DSK_BIC", type: "N", len: 12 },
  { name: "DSK_RATE", type: "N", len: 5 },
  { name: "DSK_PRATE", type: "N", len: 2 },
  { name: "DSK_BIMH", type: "N", len: 12 },
  { name: "MON_PYM", type: "C", len: 3 },
];

const WOR: Field[] = [
  { name: "DSW_ID", type: "C", len: 10 },
  { name: "DSW_YY", type: "N", len: 2 },
  { name: "DSW_MM", type: "N", len: 2 },
  { name: "DSW_LISTNO", type: "C", len: 12 },
  { name: "DSW_ID1", type: "C", len: 10 },
  { name: "DSW_FNAME", type: "C", len: 100 },
  { name: "DSW_LNAME", type: "C", len: 100 },
  { name: "DSW_DNAME", type: "C", len: 100 },
  { name: "DSW_IDNO", type: "C", len: 15 },
  { name: "DSW_IDPLC", type: "C", len: 100 },
  { name: "DSW_IDATE", type: "C", len: 8 },
  { name: "DSW_BDATE", type: "C", len: 8 },
  { name: "DSW_SEX", type: "C", len: 3 },
  { name: "DSW_NAT", type: "C", len: 10 },
  { name: "DSW_OCP", type: "C", len: 100 },
  { name: "DSW_SDATE", type: "C", len: 8 },
  { name: "DSW_EDATE", type: "C", len: 8 },
  { name: "DSW_DD", type: "N", len: 2 },
  { name: "DSW_ROOZ", type: "N", len: 12 },
  { name: "DSW_MAH", type: "N", len: 12 },
  { name: "DSW_MAZ", type: "N", len: 12 },
  { name: "DSW_MASH", type: "N", len: 12 },
  { name: "DSW_TOTL", type: "N", len: 12 },
  { name: "DSW_BIME", type: "N", len: 12 },
  { name: "DSW_PRATE", type: "N", len: 2 },
  { name: "DSW_JOB", type: "C", len: 6 },
  { name: "PER_NATCOD", type: "C", len: 10 },
];

// ------------------------------------------------------------------ zip

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = -1;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

// a zip of stored (uncompressed) files
export const zip = (files: { name: string; data: Buffer }[]) => {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // MS-DOS time and date of now, as zip headers keep them
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, "ascii");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, f.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
};

// ------------------------------------------------------------- the list

const jdate = (d?: Date | null) => (d ? moment(d).format("jYYYYjMMjDD") : "");

const splitName = (e: Pick<IBizEmployee, "name" | "firstName" | "lastName">) => {
  if (e.firstName || e.lastName) return { first: e.firstName || "", last: e.lastName || "" };
  const parts = (e.name || "").trim().split(/\s+/);
  return { first: parts.slice(0, -1).join(" ") || parts[0] || "", last: parts.length > 1 ? parts[parts.length - 1] : "" };
};

export const getPayrollSettings = (owner: BizOwner) => BizPayrollSettings.findOne(own(owner)).lean<IBizPayrollSettings>();

// what the disk of a month's run needs and still misses
export const diskProblems = async (owner: BizOwner, runId: unknown) => {
  const run = await BizPayrun.findOne({ ...own(owner), _id: runId }).lean<IBizPayrun>();
  if (!run) throw new AppError("لیست حقوق پیدا نشد", 404);
  const settings = await getPayrollSettings(owner);
  const insured = run.slips.filter((s) => s.insuranceBase > 0);
  const emps = await BizEmployee.find({ ...own(owner), _id: { $in: insured.map((s) => s.employee) } }).lean<IBizEmployee[]>();
  const byId = new Map(emps.map((e) => [String(e._id), e]));
  const missing: { name: string; fields: string[] }[] = [];
  for (const s of insured) {
    const e = byId.get(String(s.employee));
    const fields: string[] = [];
    if (!(e?.insuranceNo || s.insuranceNo)) fields.push("insuranceNo");
    if (!(e?.nationalId || s.nationalId)) fields.push("nationalId");
    if (!e?.jobCode) fields.push("jobCode");
    if (fields.length) missing.push({ name: s.name, fields });
  }
  return {
    run,
    settings,
    insured,
    byId,
    workshop: !settings?.workshopCode ? ["workshopCode"] : [],
    missing,
  };
};

export const taminDisk = async (owner: BizOwner, runId: unknown) => {
  const p = await diskProblems(owner, runId);
  if (p.workshop.length) throw new AppError("کد کارگاه تأمین اجتماعی را در تنظیمات حقوق وارد کنید", 400);
  if (!p.insured.length) throw new AppError("در این لیست کارمند بیمه‌شده‌ای نیست", 400);
  if (p.missing.length) throw new AppError("شماره‌ی بیمه، کد ملی یا کد شغل این کارکنان ثبت نشده است: ${1}".replace("${1}", p.missing.map((m) => m.name).join("، ")), 400);
  const s = p.settings!;
  const rules = await yearRules(p.run.year);
  const encode = s.encoding === "windows1256" ? toW1256 : toIranSystem;
  const yy = p.run.year % 100;
  const mm = p.run.month;
  const listNo = s.listNo || "01";
  const unemploymentRate = Math.min(3, rules.employerInsuranceRate);
  const rows = p.insured.map((slip) => {
    const e = p.byId.get(String(slip.employee))!;
    const { first, last } = splitName(e);
    const days = Math.round(slip.workedDays);
    const monthly = rial(slip.base);
    const daily = days ? Math.round(monthly / days) : 0;
    const subject = rial(slip.insuranceBase);
    const benefits = Math.max(0, subject - monthly);
    const total = rial(slip.gross);
    const ended = e.endDate && e.endDate >= p.run.periodStart && e.endDate <= p.run.periodEnd ? jdate(e.endDate) : "";
    const started = e.hireDate ? jdate(e.hireDate) : "";
    return {
      days,
      daily,
      monthly,
      benefits,
      subject,
      total,
      worker: rial(slip.insuranceEmployee),
      employer: Math.round((subject * (rules.employerInsuranceRate - unemploymentRate)) / 100),
      unemployment: Math.round((subject * unemploymentRate) / 100),
      row: [
        s.workshopCode,
        yy,
        mm,
        listNo,
        e.insuranceNo || slip.insuranceNo || "",
        first,
        last,
        e.fatherName || "",
        e.idNumber || "",
        e.idPlace || "",
        "",
        jdate(e.birthDate),
        e.gender === "female" ? "زن" : "مرد",
        e.nationality || "ایرانی",
        e.position || slip.position || "",
        started,
        ended,
        days,
        daily,
        monthly,
        benefits,
        subject,
        total,
        rial(slip.insuranceEmployee),
        0,
        e.jobCode || "",
        e.nationalId || slip.nationalId || "",
      ] as (string | number)[],
    };
  });
  const sum = (k: "days" | "daily" | "monthly" | "benefits" | "subject" | "total" | "worker" | "employer" | "unemployment") =>
    rows.reduce((a, r) => a + r[k], 0);
  const kar = dbf(
    KAR,
    [
      [
        s.workshopCode!,
        s.workshopName || "",
        s.employerName || "",
        s.address || "",
        0,
        yy,
        mm,
        listNo,
        `لیست ${mm} ${p.run.year}`,
        rows.length,
        sum("days"),
        sum("daily"),
        sum("monthly"),
        sum("benefits"),
        sum("subject"),
        sum("total"),
        sum("worker"),
        sum("employer"),
        sum("unemployment"),
        rules.employerInsuranceRate,
        0,
        0,
        s.contractRow || "000",
      ],
    ],
    encode,
  );
  const wor = dbf(WOR, rows.map((r) => r.row), encode);
  return {
    file: zip([
      { name: "DSKKAR00.DBF", data: kar },
      { name: "DSKWOR00.DBF", data: wor },
    ]),
    name: `tamin-${p.run.year}-${String(mm).padStart(2, "0")}.zip`,
  };
};

// for tests: the encoders on their own
export const encoders = { toIranSystem, toW1256 };
