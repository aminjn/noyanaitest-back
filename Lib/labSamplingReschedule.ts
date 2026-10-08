import mongoose, { Types } from "mongoose";
import LabSampling, {
  ILabSampling,
  ILabSamplingPlace,
  LabSamplingActor,
  LabSamplingKind,
} from "../Models/LabSampling";
import UserAddress from "../Models/UserAddress";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import { getAppConfig } from "./appConfig";
import { getOrderResponseSettings } from "./orderResponse";
import {
  giveSeat,
  loadSamplingSettings,
  resolveSamplingSlot,
  samplingCapacity,
  samplingKindOpen,
  SamplingSettings,
  samplingWhenText,
  takeSeat,
} from "./labSampling";
import { tehranJalaliFormat } from "./tehranTime";
import { latestProposalView, SamplingProposalView } from "./labSamplingProposalView";

// Moving a lab sampling appointment (2026-10, owner decision).
//
// Doctolib / Zocdoc let the patient move a booking themselves up to the
// practice's notice and let the practice move it with the patient told and
// free to cancel; Halodoc does the same for lab home visits. NoyanAI copies
// that for Models/LabSampling.ts, with no cancel / refund in the move itself:
//
//   - who: the buyer (order page), the lab (agenda / incoming order page),
//     support (super admin order page - not limited by the notice or the
//     count, still by the schedule and capacity)
//   - what: another free slot of the same lab; the buyer and support may
//     also switch in-lab <-> home when every test of it allows home
//     (ParaClinicTest.sampling "labOrHome") - the home fee difference is
//     charged on / refunded to the buyer's wallet, once (Transaction.orderItem
//     = the move's _id; the booking update is the lock)
//   - limits: not after the sample was taken (or its fee settled), not
//     within the lab's minimum notice (leadMinutes) of the current time,
//     at most AppConfig.labSamplingMaxMoves moves
//   - atomic: the new seat is taken first (capacity check), then the
//     appointment is moved conditional on its version (moveCount), then the
//     old seat is given back - never two seats, never none
//   - after: the reminder is re-armed for the new time, the order lines'
//     samplingAt and the lab's response deadline (respondBy, Lib/
//     orderResponse.ts) follow, and the other side is told (in-app + SMS).
//     A move by the lab or support tells the buyer they may cancel the
//     appointment for a full refund (cancelSamplingAppointment).

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const idOf = (value: unknown) => String((value as { _id?: unknown })?._id ?? value ?? "");

type OrderLine = {
  _id: Types.ObjectId;
  item: unknown;
  status: string;
  acceptedAt?: Date;
  sampling?: unknown;
};
type SamplingOrder = {
  _id: Types.ObjectId;
  user: unknown;
  status: string;
  paidAt?: Date;
  tests?: OrderLine[];
};

const loadOrder = (orderId: unknown) =>
  mongoose
    .model("Order")
    .findById(idOf(orderId))
    .select("user status paidAt tests")
    .lean<SamplingOrder>();

const coveredLines = (booking: Pick<ILabSampling, "lines">, order: SamplingOrder | null) => {
  const covered = new Set((booking.lines || []).map(String));
  return (order?.tests || []).filter((l) => covered.has(String(l._id)));
};

export const getSamplingMaxMoves = async (): Promise<number> => {
  try {
    const n = Number((await getAppConfig()).labSamplingMaxMoves);
    return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 2;
  } catch {
    return 2;
  }
};

// home sampling is possible for these lines: the lab offers it and every
// line still waiting may be done at home
const homeAllowedFor = async (lines: OrderLine[], settings: SamplingSettings) => {
  if (!samplingKindOpen(settings, "home")) return false;
  const pending = lines.filter((l) => l.status === "pending");
  if (!pending.length) return false;
  const ids = [...new Set(pending.map((l) => idOf(l.item)))];
  const tests = await mongoose
    .model("ParaClinicTest")
    .find({ _id: { $in: ids } })
    .select("sampling")
    .lean<{ sampling?: string }[]>();
  return tests.length === ids.length && tests.every((t) => t.sampling === "labOrHome");
};

// the cities a lab's home sampling serves: its list, or else its own city
const servedCities = async (settings: SamplingSettings): Promise<string[]> => {
  if (settings.home.cities.length) return settings.home.cities;
  const lab = await mongoose
    .model("ParaClinic")
    .findById(settings.paraClinic)
    .select("city")
    .lean<{ city?: unknown }>();
  return lab?.city ? [idOf(lab.city)] : [];
};

export type SamplingMoveBlock =
  | "notActive"
  | "collected"
  | "notPaid"
  | "noPendingLine"
  | "off"
  | "tooLate"
  | "limit";

export type SamplingMoveInfo = {
  canMove: boolean;
  block?: SamplingMoveBlock;
  // null: not limited (support)
  movesLeft: number | null;
  maxMoves: number;
  leadMinutes: number;
  // the actor may switch in-lab <-> home (buyer, support)
  canSwitchKind: boolean;
  // home is possible for this appointment, its fee and served cities
  home: boolean;
  homeFee: number;
  homeCities: string[];
  // the buyer may cancel the appointment's tests (full refund)
  canCancel: boolean;
  // the last move was the lab's or support's: the buyer was told and may
  // cancel
  movedByOther: boolean;
  // the lab's latest in-lab <-> home proposal, open or how it ended
  // (Lib/labSamplingProposal.ts); the lab may make one while none is open
  proposal: SamplingProposalView | null;
  // the lab may propose the other kind now (Lib/labSamplingProposal.ts
  // proposeSamplingSwitch runs the same checks)
  canPropose: boolean;
};

// What the actor may do with an appointment right now - the same checks
// rescheduleSampling runs, for the buttons of the three UIs.
export const samplingMoveInfo = async (
  booking: ILabSampling,
  actor: LabSamplingActor,
  opts: { order?: SamplingOrder | null; settings?: SamplingSettings; maxMoves?: number; now?: Date } = {},
): Promise<SamplingMoveInfo> => {
  const now = opts.now || new Date();
  const settings = opts.settings || (await loadSamplingSettings(idOf(booking.paraClinic)));
  const maxMoves = opts.maxMoves ?? (await getSamplingMaxMoves());
  const order = opts.order === undefined ? await loadOrder(booking.order) : opts.order;
  const lines = coveredLines(booking, order);
  const home = await homeAllowedFor(lines, settings).catch(() => false);
  const moves = Number(booking.moveCount) || (booking.moves || []).length;
  const last = (booking.moves || [])[(booking.moves || []).length - 1];
  const block: SamplingMoveBlock | undefined =
    booking.status !== "active"
      ? "notActive"
      : booking.collectedAt || booking.feeSettled
        ? "collected"
        : order?.status !== "paid"
          ? "notPaid"
          : !lines.some((l) => l.status === "pending")
            ? "noPendingLine"
            : !samplingKindOpen(settings, booking.kind) && !(actor !== "lab" && home)
              ? "off"
              : actor !== "admin" &&
                  new Date(booking.startsAt).getTime() < now.getTime() + settings.leadMinutes * MINUTE
                ? "tooLate"
                : actor !== "admin" && moves >= maxMoves
                  ? "limit"
                  : undefined;
  const proposal = latestProposalView(booking, now);
  return {
    canMove: !block,
    ...(block ? { block } : {}),
    movesLeft: actor === "admin" ? null : Math.max(0, maxMoves - moves),
    maxMoves,
    leadMinutes: settings.leadMinutes,
    canSwitchKind: actor !== "lab",
    home,
    homeFee: home ? settings.home.fee : 0,
    homeCities: home ? await servedCities(settings) : [],
    canCancel:
      booking.status === "active" &&
      !booking.collectedAt &&
      order?.status === "paid" &&
      lines.some((l) => l.status === "pending"),
    movedByOther: !!last && last.by !== "buyer",
    proposal,
    canPropose:
      actor === "lab" &&
      (!block || block === "off") &&
      // the buyer's own limits apply: accepting is the buyer's move
      new Date(booking.startsAt).getTime() >= now.getTime() + settings.leadMinutes * MINUTE &&
      moves < maxMoves &&
      (booking.kind === "home" ? samplingKindOpen(settings, "lab") : home) &&
      proposal?.status !== "open",
  };
};

export type RescheduleResult =
  | { error: string; status: number }
  | { booking: ILabSampling; feeDelta: number };

const fail = (error: string, status = 409) => ({ error, status });

const placeOf = (b: Pick<ILabSampling, "kind" | "ymd" | "start" | "end" | "startsAt" | "address" | "fee">): ILabSamplingPlace => ({
  kind: b.kind,
  ymd: b.ymd,
  start: b.start,
  end: b.end,
  startsAt: b.startsAt,
  ...(b.address ? { address: new Types.ObjectId(idOf(b.address)) } : {}),
  fee: Number(b.fee) || 0,
});

// Moves one appointment. `scope` limits it to the lab's / the buyer's own
// (a mismatch reads as not found).
export const rescheduleSampling = async (args: {
  bookingId: unknown;
  actor: LabSamplingActor;
  actorUser?: unknown;
  scope?: { paraClinic?: unknown; user?: unknown };
  kind?: LabSamplingKind;
  ymd: string;
  start: number;
  address?: string;
  reason?: string;
  // the lab's proposal the buyer is accepting (Lib/labSamplingProposal.ts)
  proposal?: unknown;
  now?: Date;
}): Promise<RescheduleResult> => {
  const now = args.now || new Date();
  const filter: Record<string, unknown> = { _id: args.bookingId };
  if (args.scope?.paraClinic) filter.paraClinic = args.scope.paraClinic;
  if (args.scope?.user) filter.user = args.scope.user;
  const booking = await LabSampling.findOne(filter).lean<ILabSampling>();
  if (!booking) return fail("هیچ نوبت نمونه‌گیری با این آی دی یافت نشد", 404);
  const settings = await loadSamplingSettings(idOf(booking.paraClinic));
  const maxMoves = await getSamplingMaxMoves();
  const order = await loadOrder(idOf(booking.order));
  const info = await samplingMoveInfo(booking, args.actor, { order, settings, maxMoves, now });
  switch (info.block) {
    case "notActive":
      return fail("این نوبت نمونه‌گیری دیگر فعال نیست");
    case "collected":
      return fail("نمونه‌ی این نوبت گرفته شده و دیگر جابه‌جا نمی‌شود");
    case "notPaid":
    case "noPendingLine":
      return fail("این نوبت آزمایش در انتظاری ندارد و جابه‌جا نمی‌شود");
    case "off":
      return fail("این زمان نمونه‌گیری دیگر در دسترس نیست؛ زمان دیگری انتخاب کنید");
    case "tooLate":
      return fail(`جابه‌جایی نوبت نمونه‌گیری فقط تا ${settings.leadMinutes} دقیقه پیش از زمان آن ممکن است`);
    case "limit":
      return maxMoves === 0
        ? fail("جابه‌جایی نوبت نمونه‌گیری امکان‌پذیر نیست")
        : fail(`این نوبت به سقف ${maxMoves} بار جابه‌جایی رسیده است`);
  }

  const kind: LabSamplingKind = args.kind || booking.kind;
  if (kind !== booking.kind && !info.canSwitchKind)
    return fail("آزمایشگاه نمی‌تواند نمونه‌گیری در منزل و در آزمایشگاه را جابه‌جا کند", 403);
  if (kind === "home" && !info.home)
    return fail("نمونه‌گیری در منزل برای این آزمایش‌ها ممکن نیست", 400);

  // the address: a home visit keeps its address unless a new one is given;
  // a new one (or a switch to home) is checked like at checkout
  let address: string | undefined;
  if (kind === "home") {
    const keep = booking.kind === "home" && booking.address && (!args.address || args.address === idOf(booking.address));
    if (keep) address = idOf(booking.address);
    else {
      if (!args.address) return fail("برای نمونه‌گیری در منزل، آدرس را انتخاب کنید", 400);
      const doc = await UserAddress.findOne({
        _id: args.address,
        user: idOf(booking.user),
        archived: { $ne: true },
      })
        .select("city")
        .lean<{ _id: unknown; city?: unknown }>();
      if (!doc) return fail("آدرس انتخاب‌شده معتبر نیست", 400);
      const city = doc.city ? idOf(doc.city) : "";
      if (!city || !info.homeCities.includes(city))
        return fail("نمونه‌گیری در منزل به این آدرس ارائه نمی‌شود", 400);
      address = idOf(doc._id);
    }
  }

  const slot = resolveSamplingSlot(settings, kind, args.ymd, args.start, now);
  if (!slot) return fail("این زمان نمونه‌گیری دیگر در دسترس نیست؛ زمان دیگری انتخاب کنید", 400);
  if (
    kind === booking.kind &&
    args.ymd === booking.ymd &&
    slot.start === booking.start &&
    (address || "") === (booking.address ? idOf(booking.address) : "")
  )
    return fail("این همان زمان فعلی نوبت است؛ زمان دیگری انتخاب کنید", 400);

  // the buyer paid the home fee of their booking; a time move keeps it, a
  // switch charges today's fee or gives the paid one back
  const oldFee = Number(booking.fee) || 0;
  const newFee = kind === booking.kind ? oldFee : kind === "home" ? settings.home.fee : 0;
  const feeDelta = newFee - oldFee;
  const buyer = idOf(booking.user);
  const sameSeat = kind === booking.kind && args.ymd === booking.ymd && slot.start === booking.start;

  // 1) the new seat (an address-only change keeps its seat)
  if (!sameSeat) {
    const ok = await takeSeat(idOf(booking.paraClinic), kind, args.ymd, slot.start, samplingCapacity(settings, kind));
    if (!ok) return fail("ظرفیت این زمان نمونه‌گیری پر شد؛ زمان دیگری انتخاب کنید");
  }
  const releaseNew = async () => {
    if (!sameSeat)
      await giveSeat({ paraClinic: idOf(booking.paraClinic) as never, kind, ymd: args.ymd, start: slot.start });
  };

  // 2) a switch to home: the fee difference, debited only if it is there
  let walletId: unknown;
  if (feeDelta > 0) {
    const wallet = await Wallet.findOneAndUpdate(
      { user: buyer, balance: { $gte: feeDelta } },
      { $inc: { balance: -feeDelta } },
    );
    if (!wallet) {
      await releaseNew();
      return fail(`موجودی کیف پول برای ${feeDelta.toLocaleString("en-US")} تومان هزینه‌ی نمونه‌گیری در منزل کافی نیست`, 400);
    }
    walletId = wallet._id;
  }

  // 3) the move itself, on the version that was checked
  const moveId = new Types.ObjectId();
  const moves = Number(booking.moveCount) || 0;
  const to: ILabSamplingPlace = {
    kind,
    ymd: args.ymd,
    start: slot.start,
    end: slot.end,
    startsAt: slot.startsAt,
    ...(address ? { address: new Types.ObjectId(address) } : {}),
    fee: newFee,
  };
  const moved = await LabSampling.findOneAndUpdate(
    {
      _id: booking._id,
      status: "active",
      collectedAt: { $exists: false },
      feeSettled: { $exists: false },
      kind: booking.kind,
      ymd: booking.ymd,
      start: booking.start,
      ...(moves ? { moveCount: moves } : { $or: [{ moveCount: 0 }, { moveCount: { $exists: false } }] }),
    },
    {
      $set: {
        kind,
        ymd: args.ymd,
        start: slot.start,
        end: slot.end,
        startsAt: slot.startsAt,
        fee: newFee,
        slotSetAt: now,
        moveCount: moves + 1,
        ...(address ? { address } : {}),
      },
      $unset: { remindedAt: 1, ...(address ? {} : { address: 1 }) },
      $push: {
        moves: {
          _id: moveId,
          at: now,
          by: args.actor,
          ...(args.actorUser ? { byUser: idOf(args.actorUser) } : {}),
          from: placeOf(booking),
          to,
          feeDelta,
          ...(args.reason ? { reason: args.reason } : {}),
          ...(args.proposal ? { proposal: idOf(args.proposal) } : {}),
        },
      },
    },
    { new: true },
  ).lean<ILabSampling>();
  if (!moved) {
    if (walletId) await Wallet.updateOne({ _id: walletId }, { $inc: { balance: feeDelta } });
    await releaseNew();
    return fail("این نوبت همزمان تغییر کرد؛ صفحه را تازه کنید و دوباره تلاش کنید");
  }

  // 4) the money record of the difference; a switch back to the lab gives
  //    the paid fee back now (the update above ran once)
  try {
    if (feeDelta > 0)
      await Transaction.create({ user: buyer, amount: -feeDelta, order: booking.order, orderItem: moveId });
    else if (feeDelta < 0) {
      const wallet = await Wallet.findOneAndUpdate({ user: buyer }, { user: buyer }, { upsert: true, new: true });
      await Wallet.updateOne({ _id: wallet._id }, { $inc: { balance: -feeDelta } });
      await Transaction.create({ user: buyer, amount: -feeDelta, order: booking.order, orderItem: moveId });
    }
  } catch (err) {
    console.log("[sampling] recording the reschedule fee failed:", err);
  }

  // 5) the old seat back
  if (!sameSeat) await giveSeat(booking);

  // a lab's proposal still open was about the old time: it is closed (the
  // one being accepted is already "accepted")
  await LabSampling.updateOne(
    { _id: booking._id, proposals: { $elemMatch: { status: "open" } } },
    { $set: { "proposals.$.status": "closed", "proposals.$.answeredAt": now } },
  ).catch((err) => console.log("[sampling] closing the open proposal failed:", err));

  // 6) the order follows: lines' time, the fee in the total, and the lab's
  //    response deadline of lines it has not answered yet
  await syncOrderAfterMove(moved, feeDelta, now).catch((err) =>
    console.log("[sampling] updating the order after a move failed:", err),
  );

  // 7) the other side
  await notifyMove(moved, args.actor, order).catch((err) =>
    console.log("[sampling] reschedule notice failed:", err),
  );
  return { booking: moved, feeDelta };
};

const syncOrderAfterMove = async (booking: ILabSampling, feeDelta: number, now: Date) => {
  const Order = mongoose.model("Order");
  const lineIds = booking.lines || [];
  if (!lineIds.length) return;
  const order = await Order.findById(booking.order).select("paidAt").lean<{ paidAt?: Date }>();
  const settings = await getOrderResponseSettings();
  const from = order?.paidAt ? new Date(order.paidAt).getTime() : now.getTime();
  const deadline = from + settings.labHours * HOUR;
  const startsAt = new Date(booking.startsAt).getTime();
  // as at payment (stampOrderResponseDeadlines): an hour into the
  // appointment when that is sooner than the usual window - but never
  // earlier than an hour from now (a move must not expire the lab's answer)
  const respondBy = new Date(Math.max(Math.min(deadline, Math.max(startsAt, from) + HOUR), now.getTime() + HOUR));
  await Order.updateOne(
    { _id: booking.order },
    {
      $set: { "tests.$[l].samplingAt": booking.startsAt },
      ...(feeDelta ? { $inc: { samplingFee: feeDelta, total: feeDelta } } : {}),
    },
    { arrayFilters: [{ "l._id": { $in: lineIds } }] },
  );
  await Order.updateOne(
    { _id: booking.order, status: "paid" },
    { $set: { "tests.$[u].respondBy": respondBy }, $unset: { "tests.$[u].responseWarnedAt": 1 } },
    {
      arrayFilters: [
        {
          "u._id": { $in: lineIds },
          "u.status": "pending",
          "u.acceptedAt": { $exists: false },
          "u.result.uploadedAt": { $exists: false },
        },
      ],
    },
  );
};

const notifyMove = async (booking: ILabSampling, actor: LabSamplingActor, order: SamplingOrder | null) => {
  const { notifyWithSms } = await import("../Services/notificationSmsService");
  const lab = await mongoose
    .model("ParaClinic")
    .findById(booking.paraClinic)
    .select("name user")
    .lean<{ name?: string; user?: unknown }>();
  const when = samplingWhenText(booking);
  const date = tehranJalaliFormat(booking.startsAt, "jYYYY/jMM/jDD");
  const time = tehranJalaliFormat(booking.startsAt, "HH:mm");
  const orderId = idOf(booking.order);
  const labName = lab?.name || "";
  // the buyer: told by the lab's / support's move, with the way out
  if (actor !== "buyer")
    await notifyWithSms(
      "labSamplingRescheduledUser",
      idOf(order?.user ?? booking.user),
      { labName, date, time },
      {
        notification: {
          title:
            actor === "lab"
              ? "آزمایشگاه زمان نمونه‌گیری شما را تغییر داد"
              : "پشتیبانی زمان نمونه‌گیری شما را تغییر داد",
          message: `زمان تازه‌ی نمونه‌گیری «${labName}»: ${when}. اگر این زمان برایتان مناسب نیست، می‌توانید آن را در صفحه‌ی سفارش لغو کنید و کل مبلغ را پس بگیرید.`,
          link: `/order/${orderId}`,
        },
      },
    );
  // the lab: told by the buyer's / support's move
  if (actor !== "lab" && lab?.user)
    await notifyWithSms(
      "labSamplingRescheduledLab",
      idOf(lab.user),
      { orderId: orderId.slice(-8), date, time },
      {
        notification: {
          title:
            actor === "buyer"
              ? "خریدار نوبت نمونه‌گیری را جابه‌جا کرد"
              : "پشتیبانی نوبت نمونه‌گیری را جابه‌جا کرد",
          message: `زمان تازه: ${when}`,
          link: `/paraClinicPanel/sampling?date=${booking.ymd}`,
        },
      },
    );
};

// ------------------------------------------------------------- cancelling

// The buyer (order page) or support cancels an appointment: every test it
// covers that is still waiting is cancelled through the shared settlement
// (Services/orderSettlementService.ts settleOrderLine) - the test's price
// and tax back to the wallet, and with the last line the seat and the home
// fee (Lib/labSampling.ts settleLineSampling). Never after the sample was
// taken by the buyer (the lab did the work; support may still, with a
// reason). Each line flips once ("pending" is the lock).
export const cancelSamplingAppointment = async (args: {
  bookingId: unknown;
  actor: "buyer" | "admin";
  scope?: { user?: unknown };
  note?: Record<string, unknown>;
}): Promise<{ error: string; status: number } | { cancelled: number; booking: ILabSampling }> => {
  const { settleOrderLine, notifySellerOfBuyerCancel } = await import("../Services/orderSettlementService");
  const filter: Record<string, unknown> = { _id: args.bookingId };
  if (args.scope?.user) filter.user = args.scope.user;
  const booking = await LabSampling.findOne(filter).lean<ILabSampling>();
  if (!booking) return fail("هیچ نوبت نمونه‌گیری با این آی دی یافت نشد", 404);
  if (booking.status !== "active") return fail("این نوبت نمونه‌گیری دیگر فعال نیست");
  if (booking.collectedAt && args.actor === "buyer")
    return fail("نمونه‌ی این نوبت گرفته شده و دیگر لغو نمی‌شود");
  const Order = mongoose.model("Order");
  const order = await loadOrder(idOf(booking.order));
  if (order?.status !== "paid") return fail("این نوبت آزمایش در انتظاری برای لغو ندارد");
  let cancelled = 0;
  for (const line of coveredLines(booking, order)) {
    if (line.status !== "pending") continue;
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: "paid", tests: { $elemMatch: { _id: line._id, status: "pending" } } },
      {
        $set: { "tests.$.status": "cancelled" },
        ...(args.note ? { $push: { adminNotes: { ...args.note, model: "tests", line: line._id } } } : {}),
      },
      { new: true },
    );
    if (!updated) continue;
    const itemId = idOf(line.item);
    await settleOrderLine({ order: updated, model: "tests", itemId });
    await notifySellerOfBuyerCancel(
      order._id,
      "tests",
      itemId,
      args.actor === "admin"
        ? {
            title: "پشتیبانی یک قلم سفارش را لغو کرد",
            message: "این قلم توسط پشتیبانی لغو و مبلغش به خریدار برگشت؛ آن را ارسال نکنید.",
          }
        : undefined,
    );
    cancelled++;
  }
  if (!cancelled) return fail("این نوبت آزمایش در انتظاری برای لغو ندارد");
  const after = (await LabSampling.findById(booking._id).lean<ILabSampling>()) || booking;
  return { cancelled, booking: after };
};

// test lines of an order whose sample was already taken: the buyer's
// whole-order cancel leaves them to the lab (Controllers/userController.ts)
export const collectedSamplingLines = async (orderId: unknown): Promise<Set<string>> => {
  const done = await LabSampling.find({ order: orderId, collectedAt: { $exists: true } })
    .select("lines")
    .lean<{ lines?: unknown[] }[]>();
  return new Set(done.flatMap((b) => (b.lines || []).map(String)));
};

// Once (2026-10): appointments booked before moves existed get moveCount 0,
// so the reschedule lock reads them like any other. A re-run changes nothing.
export const migrateLabSamplingMoves = async (): Promise<number> => {
  const res = await LabSampling.updateMany(
    { moveCount: { $exists: false } },
    { $set: { moveCount: 0 } },
  );
  return res.modifiedCount || 0;
};

// samplingMoveInfo for each appointment of a page (each once; one settings
// read per lab)
export const samplingMovesFor = async (
  bookings: unknown[],
  actor: LabSamplingActor,
): Promise<Record<string, SamplingMoveInfo>> => {
  const out: Record<string, SamplingMoveInfo> = {};
  const list = (Array.isArray(bookings) ? bookings : []).filter(
    (b): b is ILabSampling => !!b && typeof b === "object" && !!(b as { _id?: unknown })._id && !!(b as { ymd?: unknown }).ymd,
  );
  if (!list.length) return out;
  const maxMoves = await getSamplingMaxMoves();
  const settingsBy = new Map<string, SamplingSettings>();
  for (const b of list) {
    const id = idOf(b._id);
    if (out[id]) continue;
    const lab = idOf(b.paraClinic);
    if (!settingsBy.has(lab)) settingsBy.set(lab, await loadSamplingSettings(lab));
    try {
      out[id] = await samplingMoveInfo(b, actor, { settings: settingsBy.get(lab), maxMoves });
    } catch (err) {
      console.log("[sampling] move info failed:", err);
    }
  }
  return out;
};
