import mongoose, { isValidObjectId } from "mongoose";
import Insurance from "../Models/Insurance";
import InsurancePlan from "../Models/InsurancePlan";
import UserIdentity, { IIdentityInsurance } from "../Models/UserIdentity";
import UserRelative from "../Models/UserRelative";
import AppError from "./AppError";
import { endOfTehranDayYmd, tehranYmd } from "./tehranTime";

// «بیمه‌های من» (2026-10, docs/booking-benchmark.md): the patient keeps
// their basic and supplementary insurance on the account, once - like
// Zocdoc's insurance card on the profile and Doctolib's Carte Vitale +
// mutuelle - and every booking starts from it (Lib/insuranceTariffs.ts
// quoteInsurance `saved`). Stored on UserIdentity.insurances, the store the
// booking already reads and writes: at most one basic insurer and one
// supplementary one (the booking stacks exactly those two), each with its
// plan, the card's member number and its expiry. An expired card stays on
// the list (to renew it) but is never preselected.

type Id = mongoose.Types.ObjectId | string;
const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

export const MAX_MEMBER_NUMBER = 40;

export type PatientInsuranceInput = {
  insurance: string;
  plan?: string | null;
  memberNumber?: string | null;
  // a Tehran day "YYYY-MM-DD" (the card's last valid day), or none
  expiresAt?: string | null;
};

// the card is still valid on that day (no expiry: always)
export const insuranceValid = (i: Pick<IIdentityInsurance, "expiresAt">, at: Date = new Date()) =>
  !i.expiresAt || new Date(i.expiresAt).getTime() >= at.getTime();

// The identity a user may manage: their own, or a family member they added
// (POST /user/relative) - the same rule the booking applies.
export const manageableIdentity = async (userId: Id, patient?: string | null) => {
  const own = await UserIdentity.findOne({ user: userId }).select("_id givenName lastName insurances").lean();
  if (!patient || (own && String(own._id) === String(patient))) return own ? { identity: own, self: true } : null;
  if (!isValidObjectId(patient)) return null;
  if (!(await UserRelative.exists({ user: userId, other: patient }))) return null;
  const other = await UserIdentity.findById(patient).select("_id givenName lastName insurances").lean();
  return other ? { identity: other, self: false } : null;
};

// What the page shows: each saved insurance with its insurer and plan
// names, its role and whether it is still valid. An insurer turned off by
// the admin is shown as such (the patient may remove or replace it).
export const describeInsurances = async (list: IIdentityInsurance[] | undefined | null) => {
  const rows = (Array.isArray(list) ? list : []).filter((i) => !!i?.insurance);
  if (!rows.length) return [];
  const insurers = await Insurance.find({ _id: { $in: rows.map((r) => r.insurance) } })
    .select("name image isBasic active")
    .lean<{ _id: unknown; name?: string; image?: string; isBasic?: boolean; active?: boolean }[]>();
  const plans = await InsurancePlan.find({ _id: { $in: rows.map((r) => r.plan).filter(Boolean) } })
    .select("name")
    .lean<{ _id: unknown; name?: string }[]>();
  const now = new Date();
  return rows.map((r) => {
    const ins = insurers.find((i) => idOf(i._id) === idOf(r.insurance));
    return {
      insurance: { _id: idOf(r.insurance), name: ins?.name || "", image: ins?.image, isBasic: !!ins?.isBasic, active: ins?.active !== false && !!ins },
      plan: r.plan ? { _id: idOf(r.plan), name: plans.find((p) => idOf(p._id) === idOf(r.plan))?.name || "" } : null,
      role: ins?.isBasic ? "basic" : "supplementary",
      memberNumber: r.memberNumber || "",
      expiresAt: r.expiresAt || null,
      expired: !insuranceValid(r, now),
      source: r.source || "booking",
      updatedAt: r.updatedAt || null,
    };
  });
};

// Every active insurer and its plans (an old plan still has members):
// the choices of the form.
export const insuranceChoices = async () => {
  const insurers = await Insurance.find({ active: true })
    .select("name image isBasic order")
    .sort({ order: 1, _id: 1 })
    .lean<{ _id: unknown; name?: string; image?: string; isBasic?: boolean }[]>();
  const plans = insurers.length
    ? await InsurancePlan.find({ insurance: { $in: insurers.map((i) => i._id) } })
        .select("name insurance order")
        .sort({ order: 1, _id: 1 })
        .lean<{ _id: unknown; name?: string; insurance?: unknown }[]>()
    : [];
  return insurers.map((i) => ({
    _id: idOf(i._id),
    name: i.name || "",
    image: i.image,
    isBasic: !!i.isBasic,
    plans: plans.filter((p) => idOf(p.insurance) === idOf(i._id)).map((p) => ({ _id: idOf(p._id), name: p.name || "" })),
  }));
};

// Checks and normalises the list the patient saves: every insurer exists
// and is active, a plan is that insurer's own, at most one basic and one
// supplementary, a member number of letters, digits and dashes.
export const validateInsurances = async (input: PatientInsuranceInput[]): Promise<IIdentityInsurance[]> => {
  const list = Array.isArray(input) ? input : [];
  if (list.length > 2) throw new AppError("حداکثر یک بیمه‌ی پایه و یک بیمه‌ی تکمیلی می‌توانید ثبت کنید", 400);
  const ids = list.map((i) => String(i?.insurance || ""));
  if (ids.some((i) => !isValidObjectId(i))) throw new AppError("بیمه‌ی انتخاب‌شده پیدا نشد یا غیرفعال است", 400);
  if (new Set(ids).size !== ids.length) throw new AppError("هر بیمه را فقط یک بار ثبت کنید", 400);
  const insurers = ids.length
    ? await Insurance.find({ _id: { $in: ids }, active: true }).select("isBasic").lean<{ _id: unknown; isBasic?: boolean }[]>()
    : [];
  if (insurers.length !== ids.length) throw new AppError("بیمه‌ی انتخاب‌شده پیدا نشد یا غیرفعال است", 400);
  const basics = insurers.filter((i) => i.isBasic).length;
  if (basics > 1) throw new AppError("فقط یک بیمه‌ی پایه را می‌توانید انتخاب کنید", 400);
  if (insurers.length - basics > 1) throw new AppError("فقط یک بیمه‌ی تکمیلی را می‌توانید انتخاب کنید", 400);
  const now = new Date();
  const out: IIdentityInsurance[] = [];
  for (const i of list) {
    let plan: mongoose.Types.ObjectId | null = null;
    if (i.plan) {
      if (!isValidObjectId(i.plan) || !(await InsurancePlan.exists({ _id: i.plan, insurance: i.insurance })))
        throw new AppError("این طرح مال همین بیمه نیست", 400);
      plan = new mongoose.Types.ObjectId(String(i.plan));
    }
    const memberNumber = String(i.memberNumber || "")
      .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
      .trim();
    if (memberNumber && (memberNumber.length > MAX_MEMBER_NUMBER || !/^[A-Za-z0-9/-]+$/.test(memberNumber)))
      throw new AppError("شماره‌ی بیمه فقط رقم و حرف لاتین است", 400);
    let expiresAt: Date | null = null;
    if (i.expiresAt) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(i.expiresAt))) throw new AppError("تاریخ اعتبار بیمه معتبر نیست", 400);
      expiresAt = endOfTehranDayYmd(String(i.expiresAt));
    }
    out.push({
      insurance: new mongoose.Types.ObjectId(String(i.insurance)),
      plan,
      ...(memberNumber ? { memberNumber } : {}),
      expiresAt,
      source: "manual",
      updatedAt: now,
    });
  }
  // the basic one first (the booking's order)
  const basicIds = new Set(insurers.filter((i) => i.isBasic).map((i) => idOf(i._id)));
  return out.sort((a, b) => Number(basicIds.has(idOf(b.insurance))) - Number(basicIds.has(idOf(a.insurance))));
};

export const saveInsurances = async (identityId: Id, input: PatientInsuranceInput[]) => {
  const list = await validateInsurances(input);
  await UserIdentity.updateOne({ _id: identityId }, { $set: { insurances: list } });
  return list;
};

// The insurances a booking used are remembered on the patient for next
// time - only where nothing of that kind is saved yet, or what is saved
// there was itself remembered from a booking; what the patient saved on
// «بیمه‌های من» is never replaced, only its plan filled in when it had none.
export const rememberBookingInsurances = async (patient: Id, picks: { insurance: string; plan?: string | null }[]) => {
  if (!picks.length || !isValidObjectId(String(patient))) return;
  const identity = await UserIdentity.findById(patient).select("insurances").lean<{ insurances?: IIdentityInsurance[] }>();
  if (!identity) return;
  const saved = Array.isArray(identity.insurances) ? identity.insurances.filter((i) => !!i?.insurance) : [];
  const ids = [...new Set([...saved.map((s) => idOf(s.insurance)), ...picks.map((p) => p.insurance)])].filter((i) => isValidObjectId(i));
  const kinds = new Map(
    (await Insurance.find({ _id: { $in: ids } }).select("isBasic").lean<{ _id: unknown; isBasic?: boolean }[]>()).map((i) => [
      idOf(i._id),
      !!i.isBasic,
    ]),
  );
  const next = [...saved];
  const now = new Date();
  for (const p of picks.slice(0, 2)) {
    if (!kinds.has(p.insurance)) continue;
    const plan = p.plan && isValidObjectId(p.plan) ? new mongoose.Types.ObjectId(p.plan) : null;
    const same = next.findIndex((s) => idOf(s.insurance) === p.insurance);
    if (same >= 0) {
      if (!next[same].plan && plan) next[same] = { ...next[same], plan, updatedAt: now };
      continue;
    }
    const role = kinds.get(p.insurance);
    const slot = next.findIndex((s) => kinds.get(idOf(s.insurance)) === role);
    const entry: IIdentityInsurance = { insurance: new mongoose.Types.ObjectId(p.insurance), plan, expiresAt: null, source: "booking", updatedAt: now };
    if (slot < 0) next.push(entry);
    else if ((next[slot].source || "booking") === "booking") next[slot] = entry;
  }
  next.sort((a, b) => Number(!!kinds.get(idOf(b.insurance))) - Number(!!kinds.get(idOf(a.insurance))));
  await UserIdentity.updateOne({ _id: patient }, { $set: { insurances: next.slice(0, 2) } }).catch(() => undefined);
};

// the day a saved card expires, for the form ("YYYY-MM-DD", Tehran)
export const expiryYmd = (d?: Date | string | null) => (d ? tehranYmd(new Date(d)) : null);
