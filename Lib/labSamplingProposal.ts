import mongoose, { Types } from "mongoose";
import LabSampling, {
  ILabSampling,
  ILabSamplingProposal,
  LabSamplingKind,
  LabSamplingProposalStatus,
} from "../Models/LabSampling";
import LabSamplingSlot from "../Models/LabSamplingSlot";
import Notification from "../Models/Notification";
import Wallet from "../Models/Wallet";
import {
  loadSamplingSettings,
  resolveSamplingSlot,
  samplingCapacity,
  samplingKindOpen,
  samplingWhenText,
} from "./labSampling";
import { rescheduleSampling, samplingMoveInfo } from "./labSamplingReschedule";
import { tehranJalaliFormat } from "./tehranTime";
import {
  latestProposalView,
  openProposalOf,
  proposalStatusNow,
  SamplingProposalView,
} from "./labSamplingProposalView";

// The lab proposes switching an appointment in-lab <-> home (2026-10, owner
// decision).
//
// Doctolib / Zocdoc never let the practice change the *kind* of a visit on
// its own (in person <-> video): the practice proposes, the patient accepts
// or keeps what they booked; Halodoc does the same for a lab home visit. So
// here the lab may move an appointment's time on its own
// (Lib/labSamplingReschedule.ts, the buyer may cancel), but a switch - which
// changes where the patient must be and what they pay - is only a proposal:
//
//   - the lab proposes the other kind with a free slot of it (and a reason);
//     the buyer gets an in-app notice + SMS (labSamplingProposalUser)
//   - one open proposal per appointment (the push is conditional on none
//     being open); the lab may withdraw it while it is open
//   - the buyer accepts on the order page: the buyer's own reschedule runs
//     (rescheduleSampling, actor "buyer": capacity, the move limit, the home
//     fee difference charged on / refunded to the wallet once). When the
//     wallet can't cover the difference, the order page offers the SEP
//     top-up first (WalletShortfallTopUp)
//   - declined, withdrawn, or no answer before expiresAt (the earlier of
//     the two times, minus the lab's notice): nothing changes
//   - each proposal leaves "open" once: that flip is the lock (accepting
//     twice, or accept racing a withdraw, moves the appointment at most once)

const MINUTE = 60 * 1000;

const idOf = (value: unknown) => String((value as { _id?: unknown })?._id ?? value ?? "");

type Fail = { error: string; status: number };
const fail = (error: string, status = 409): Fail => ({ error, status });

const moveBlockError = (block: string, leadMinutes: number, maxMoves: number): Fail => {
  switch (block) {
    case "notActive":
      return fail("این نوبت نمونه‌گیری دیگر فعال نیست");
    case "collected":
      return fail("نمونه‌ی این نوبت گرفته شده و دیگر جابه‌جا نمی‌شود");
    case "tooLate":
      return fail(`جابه‌جایی نوبت نمونه‌گیری فقط تا ${leadMinutes} دقیقه پیش از زمان آن ممکن است`);
    case "limit":
      return maxMoves === 0
        ? fail("جابه‌جایی نوبت نمونه‌گیری امکان‌پذیر نیست")
        : fail(`این نوبت به سقف ${maxMoves} بار جابه‌جایی رسیده است`);
    default:
      return fail("این نوبت آزمایش در انتظاری ندارد و جابه‌جا نمی‌شود");
  }
};

// ---------------------------------------------------------------- propose

// The lab proposes the other kind at one of its free slots.
export const proposeSamplingSwitch = async (args: {
  bookingId: unknown;
  paraClinic: unknown;
  byUser?: unknown;
  ymd: string;
  start: number;
  reason?: string;
  now?: Date;
}): Promise<Fail | { proposal: SamplingProposalView }> => {
  const now = args.now || new Date();
  const booking = await LabSampling.findOne({ _id: args.bookingId, paraClinic: args.paraClinic }).lean<ILabSampling>();
  if (!booking) return fail("هیچ نوبت نمونه‌گیری با این آی دی یافت نشد", 404);
  if (openProposalOf(booking) && proposalStatusNow(booking, openProposalOf(booking)!, now) === "open")
    return fail("برای این نوبت یک پیشنهاد باز وجود دارد؛ ابتدا آن را پس بگیرید");
  const settings = await loadSamplingSettings(idOf(booking.paraClinic));
  // what the buyer could do on accepting it: the buyer's own reschedule
  const info = await samplingMoveInfo(booking, "buyer", { settings, now });
  if (info.block && info.block !== "off") return moveBlockError(info.block, info.leadMinutes, info.maxMoves);
  const kind: LabSamplingKind = booking.kind === "home" ? "lab" : "home";
  if (kind === "home" ? !info.home : !samplingKindOpen(settings, "lab"))
    return fail(
      kind === "home"
        ? "نمونه‌گیری در منزل برای این آزمایش‌ها ممکن نیست"
        : "نمونه‌گیری در آزمایشگاه در برنامه‌ی شما فعال نیست",
      400,
    );
  const slot = resolveSamplingSlot(settings, kind, args.ymd, args.start, now);
  if (!slot) return fail("این زمان نمونه‌گیری دیگر در دسترس نیست؛ زمان دیگری انتخاب کنید", 400);
  // a seat must be free now (it is taken only when the buyer accepts)
  const counter = await LabSamplingSlot.findOne({
    paraClinic: booking.paraClinic,
    kind,
    ymd: args.ymd,
    start: slot.start,
  })
    .select("booked")
    .lean<{ booked?: number }>();
  if ((Number(counter?.booked) || 0) >= samplingCapacity(settings, kind))
    return fail("ظرفیت این زمان نمونه‌گیری پر شد؛ زمان دیگری انتخاب کنید");
  // open until the earlier of the two times, minus the lab's notice (after
  // that the buyer's reschedule is no longer possible)
  const expiresAt = new Date(
    Math.min(new Date(booking.startsAt).getTime(), slot.startsAt.getTime()) - settings.leadMinutes * MINUTE,
  );
  if (expiresAt.getTime() <= now.getTime())
    return fail(`جابه‌جایی نوبت نمونه‌گیری فقط تا ${settings.leadMinutes} دقیقه پیش از زمان آن ممکن است`);
  const fee = kind === "home" ? settings.home.fee : 0;
  const proposal: ILabSamplingProposal = {
    _id: new Types.ObjectId(),
    at: now,
    ...(args.byUser ? { byUser: new Types.ObjectId(idOf(args.byUser)) } : {}),
    kind,
    ymd: args.ymd,
    start: slot.start,
    end: slot.end,
    startsAt: slot.startsAt,
    fee,
    feeDelta: fee - (Number(booking.fee) || 0),
    ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
    expiresAt,
    status: "open",
  };
  // an open one past its time is first marked as it is now
  await settleStaleProposal(booking, now);
  // one open proposal per appointment, on the appointment as checked
  const pushed = await LabSampling.findOneAndUpdate(
    {
      _id: booking._id,
      status: "active",
      kind: booking.kind,
      ymd: booking.ymd,
      start: booking.start,
      collectedAt: { $exists: false },
      proposals: { $not: { $elemMatch: { status: "open" } } },
    },
    { $push: { proposals: proposal } },
    { new: true },
  ).lean<ILabSampling>();
  if (!pushed) return fail("این نوبت همزمان تغییر کرد؛ صفحه را تازه کنید و دوباره تلاش کنید");
  await notifyBuyerOfProposal(pushed, proposal).catch((err) =>
    console.log("[sampling] proposal notice failed:", err),
  );
  return { proposal: latestProposalView(pushed, now)! };
};

// an "open" proposal that is over (time passed, appointment gone) is
// written as such
const settleStaleProposal = async (booking: ILabSampling, now: Date) => {
  const p = openProposalOf(booking);
  if (!p) return;
  const status = proposalStatusNow(booking, p, now);
  if (status === "open") return;
  await LabSampling.updateOne(
    { _id: booking._id, proposals: { $elemMatch: { _id: p._id, status: "open" } } },
    { $set: { "proposals.$.status": status, "proposals.$.answeredAt": now } },
  );
};

// ------------------------------------------------------------- answering

// one open proposal -> `to`, once; null when it was no longer open
const flip = async (bookingId: unknown, proposalId: unknown, to: LabSamplingProposalStatus, now: Date) =>
  LabSampling.findOneAndUpdate(
    {
      _id: bookingId,
      proposals: { $elemMatch: { _id: proposalId, status: "open", expiresAt: { $gt: now } } },
    },
    { $set: { "proposals.$.status": to, "proposals.$.answeredAt": now } },
    { new: true },
  ).lean<ILabSampling>();

const findOpen = async (filter: Record<string, unknown>, proposalId: unknown, now: Date) => {
  const booking = await LabSampling.findOne(filter).lean<ILabSampling>();
  if (!booking) return { error: fail("هیچ نوبت نمونه‌گیری با این آی دی یافت نشد", 404) };
  const p = (booking.proposals || []).find((x) => idOf(x._id) === idOf(proposalId));
  if (!p || proposalStatusNow(booking, p, now) !== "open") {
    await settleStaleProposal(booking, now);
    return { error: fail("این پیشنهاد دیگر معتبر نیست") };
  }
  return { booking, proposal: p };
};

// The lab takes its open proposal back.
export const withdrawSamplingProposal = async (args: {
  bookingId: unknown;
  paraClinic: unknown;
  proposalId?: unknown;
  now?: Date;
}): Promise<Fail | { ok: true }> => {
  const now = args.now || new Date();
  const booking = await LabSampling.findOne({ _id: args.bookingId, paraClinic: args.paraClinic }).lean<ILabSampling>();
  if (!booking) return fail("هیچ نوبت نمونه‌گیری با این آی دی یافت نشد", 404);
  const open = openProposalOf(booking);
  const id = args.proposalId || open?._id;
  const found = await findOpen({ _id: booking._id }, id, now);
  if ("error" in found) return found.error!;
  const done = await flip(booking._id, found.proposal._id, "withdrawn", now);
  if (!done) return fail("این پیشنهاد دیگر معتبر نیست");
  await Notification.create({
    user: idOf(booking.user),
    source: "System",
    title: "آزمایشگاه پیشنهاد تغییر نوبت نمونه‌گیری را پس گرفت",
    message: "نوبت فعلی شما بدون تغییر می‌ماند.",
    link: `/order/${idOf(booking.order)}`,
  }).catch(() => undefined);
  return { ok: true };
};

// The buyer declines: nothing changes; the lab is told.
export const declineSamplingProposal = async (args: {
  bookingId: unknown;
  user: unknown;
  proposalId: unknown;
  now?: Date;
}): Promise<Fail | { ok: true }> => {
  const now = args.now || new Date();
  const found = await findOpen({ _id: args.bookingId, user: args.user }, args.proposalId, now);
  if ("error" in found) return found.error!;
  const done = await flip(found.booking._id, found.proposal._id, "declined", now);
  if (!done) return fail("این پیشنهاد دیگر معتبر نیست");
  await notifyLabOfDecline(found.booking).catch(() => undefined);
  return { ok: true };
};

// The buyer accepts: the buyer's own reschedule to the proposed place
// (for home, at one of the buyer's addresses the lab serves).
export const acceptSamplingProposal = async (args: {
  bookingId: unknown;
  user: unknown;
  proposalId: unknown;
  address?: string;
  now?: Date;
}): Promise<Fail | { booking: ILabSampling; feeDelta: number }> => {
  const now = args.now || new Date();
  const found = await findOpen({ _id: args.bookingId, user: args.user }, args.proposalId, now);
  if ("error" in found) return found.error!;
  const { booking, proposal } = found;
  if (proposal.kind === "home" && !args.address)
    return fail("برای نمونه‌گیری در منزل، آدرس را انتخاب کنید", 400);
  // the wallet first, so the buyer is sent to the top-up before anything
  // is locked (the reschedule debits atomically anyway)
  const settings = await loadSamplingSettings(idOf(booking.paraClinic));
  const feeDelta = (proposal.kind === "home" ? settings.home.fee : 0) - (Number(booking.fee) || 0);
  if (feeDelta > 0) {
    const wallet = await Wallet.findOne({ user: idOf(booking.user) }).select("balance").lean<{ balance?: number }>();
    if ((Number(wallet?.balance) || 0) < feeDelta)
      return fail(`موجودی کیف پول برای ${feeDelta.toLocaleString("en-US")} تومان هزینه‌ی نمونه‌گیری در منزل کافی نیست`, 400);
  }
  // the lock: open -> accepted once
  const locked = await flip(booking._id, proposal._id, "accepted", now);
  if (!locked) return fail("این پیشنهاد دیگر معتبر نیست");
  const result = await rescheduleSampling({
    bookingId: booking._id,
    actor: "buyer",
    actorUser: args.user,
    scope: { user: args.user },
    kind: proposal.kind,
    ymd: proposal.ymd,
    start: proposal.start,
    ...(proposal.kind === "home" ? { address: args.address } : {}),
    proposal: proposal._id,
    now,
  });
  if ("error" in result) {
    // nothing moved: the proposal is open again (the buyer may top up and
    // retry, or decline; the lab may withdraw)
    await LabSampling.updateOne(
      { _id: booking._id, proposals: { $elemMatch: { _id: proposal._id, status: "accepted" } } },
      { $set: { "proposals.$.status": "open" }, $unset: { "proposals.$.answeredAt": 1 } },
    );
    return result;
  }
  return result;
};

// ----------------------------------------------------------------- sweep

// Open proposals past their time, or of appointments that ended / whose
// sample was taken, are written as expired / closed (the readers already
// show them so). Run by the lab sampling sweep.
export const sweepSamplingProposals = async (now = new Date()): Promise<number> => {
  const due = await LabSampling.find({ proposals: { $elemMatch: { status: "open" } } })
    .select("status collectedAt feeSettled proposals")
    .limit(500)
    .lean<ILabSampling[]>();
  let n = 0;
  for (const b of due) {
    const p = openProposalOf(b);
    if (!p || proposalStatusNow(b, p, now) === "open") continue;
    await settleStaleProposal(b, now);
    n++;
  }
  return n;
};

// -------------------------------------------------------------- notices

const notifyBuyerOfProposal = async (booking: ILabSampling, p: ILabSamplingProposal) => {
  const { notifyWithSms } = await import("../Services/notificationSmsService");
  const lab = await mongoose
    .model("ParaClinic")
    .findById(booking.paraClinic)
    .select("name")
    .lean<{ name?: string }>();
  const labName = lab?.name || "";
  const when = samplingWhenText(p);
  await notifyWithSms(
    "labSamplingProposalUser",
    idOf(booking.user),
    {
      labName,
      date: tehranJalaliFormat(p.startsAt, "jYYYY/jMM/jDD"),
      time: tehranJalaliFormat(p.startsAt, "HH:mm"),
    },
    {
      notification: {
        title: "آزمایشگاه پیشنهاد تغییر نوبت نمونه‌گیری داده است",
        message:
          p.kind === "home"
            ? `«${labName}» پیشنهاد می‌دهد نمونه‌گیری در منزل شما در ${when} انجام شود. در صفحه‌ی سفارش آن را بپذیرید یا رد کنید؛ اگر پاسخ ندهید، نوبت فعلی سر جایش می‌ماند.`
            : `«${labName}» پیشنهاد می‌دهد نمونه‌گیری در آزمایشگاه در ${when} انجام شود. در صفحه‌ی سفارش آن را بپذیرید یا رد کنید؛ اگر پاسخ ندهید، نوبت فعلی سر جایش می‌ماند.`,
        link: `/order/${idOf(booking.order)}`,
      },
    },
  );
};

// (an accepted one is the buyer's move: Lib/labSamplingReschedule.ts tells
// the lab with labSamplingRescheduledLab)
const notifyLabOfDecline = async (booking: ILabSampling) => {
  const lab = await mongoose
    .model("ParaClinic")
    .findById(booking.paraClinic)
    .select("user")
    .lean<{ user?: unknown }>();
  if (!lab?.user) return;
  await Notification.create({
    user: idOf(lab.user),
    source: "System",
    title: "خریدار پیشنهاد تغییر نوبت نمونه‌گیری را نپذیرفت",
    message: "نوبت فعلی بدون تغییر می‌ماند.",
    link: `/paraClinicPanel/sampling?date=${booking.ymd}`,
  });
};
