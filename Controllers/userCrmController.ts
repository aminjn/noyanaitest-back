import express, { Request, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizContact, { IBizContact } from "../Models/BizContact";
import BizClubSettings, { IBizClubSettings } from "../Models/BizClubSettings";
import BizClubReward from "../Models/BizClubReward";
import BizClubRedemption from "../Models/BizClubRedemption";
import BizTicket, { bizTicketCategories, IBizTicket } from "../Models/BizTicket";
import { bizOwnerKinds } from "../Models/BizAccount";
import { BizOwner } from "../Lib/business/coa";
import { nextDocNumber } from "../Lib/business/voucher";
import { orgInfo } from "../Lib/business/campaign";
import { cancelRedemption, clubSettings, memberRows, reconcileRedemptions, redeemReward } from "../Lib/business/crmService/club";
import { computeSla, pickAssignee } from "../Lib/business/crmService/tickets";
import { crmLink, idRe, isId, notify, oid } from "../Lib/business/crmService/common";
import { partOn } from "../Lib/business/crmService/profiles";
import { fireFlows } from "../Lib/business/crmService/flow";
import {
  declineOffer,
  historyOf,
  linkOffer,
  linksOf,
  Meta,
  metaOf,
  pendingOffers,
  rateLimit,
  refreshOffers,
  snoozeOffer,
  unlinkContact,
} from "../Lib/business/crmService/link";

// The patient's side of the centres' CRM (2026-10), under /user/crm:
//   - «باشگاه‌های من»: every centre whose club they are a member of (they
//     visited or bought there), with points, tier, rewards and their codes;
//     a reward is taken here and its code shown at the desk;
//   - «پیام به مراکز»: requests and complaints to a centre they are a
//     patient of (Models/BizTicket.ts), without the team's internal notes.

const me = (req: Request) => String(req.user?._id || "");
const ownerKind = z.enum(bizOwnerKinds.filter((k) => k !== "platform") as [string, ...string[]]);
const ownerOfParams = (req: Request): BizOwner => {
  const k = ownerKind.safeParse(req.params.ownerKind);
  if (!k.success || !isId(req.params.ownerId)) throw new NotFoundError();
  return { kind: k.data as BizOwner["kind"], id: req.params.ownerId };
};
const contactsOfMe = (req: Request) => BizContact.find({ user: oid(me(req)), isActive: { $ne: false } }).lean<IBizContact[]>();
const ownerOfContact = (c: IBizContact): BizOwner => ({ kind: c.ownerKind, id: String(c.ownerId) });
const publicTicket = (t: IBizTicket) => ({
  _id: t._id,
  number: t.number,
  subject: t.subject,
  category: t.category,
  status: t.status,
  ownerKind: t.ownerKind,
  ownerId: t.ownerId,
  createdAt: t.createdAt,
  lastMessageAt: t.lastMessageAt,
  messages: (t.messages || []).filter((m) => !m.internal).map((m) => ({ _id: m._id, body: m.body, fromPatient: m.fromPatient, at: m.at })),
});

// the clubs the patient is in (enabled ones only)
const getClubs = catchAsync(async (req: Request, res: Response) => {
  const contacts = await contactsOfMe(req);
  if (!contacts.length) return res.status(200).json({ message: "myClubs", data: [] });
  const enabled = await BizClubSettings.find({ enabled: true, $or: contacts.map((c) => ({ ownerKind: c.ownerKind, ownerId: c.ownerId })) }).lean<IBizClubSettings[]>();
  const on = new Set(enabled.map((s) => `${s.ownerKind}:${s.ownerId}`));
  const out = [];
  // an insurer has no club (Lib/business/crmService/profiles.ts)
  for (const c of contacts.filter((x) => on.has(`${x.ownerKind}:${x.ownerId}`) && partOn(x.ownerKind, "club"))) {
    const owner = ownerOfContact(c);
    await reconcileRedemptions(owner);
    const settings = await clubSettings(owner);
    const [[row], rewards, codes, info] = await Promise.all([
      memberRows(owner, [c], settings),
      BizClubReward.find({ ownerKind: c.ownerKind, ownerId: c.ownerId, active: true }).sort({ points: 1 }).select("name description points kind value maxDiscount").lean(),
      BizClubRedemption.find({ ownerKind: c.ownerKind, ownerId: c.ownerId, contact: c._id, status: { $in: ["issued", "applied", "used"] } })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("name kind value maxDiscount points code status expiresAt discountAmount createdAt")
        .lean(),
      orgInfo(owner).catch(() => ({ name: "" })),
    ]);
    out.push({
      ownerKind: c.ownerKind,
      ownerId: c.ownerId,
      name: info.name,
      member: row,
      tiers: settings.tiers,
      pointUnit: settings.pointUnit,
      perVisit: settings.perVisit,
      rewards,
      codes,
    });
  }
  res.status(200).json({ message: "myClubs", data: out });
});

const redeem = catchAsync(async (req: Request, res: Response) => {
  const owner = ownerOfParams(req);
  if (!partOn(owner.kind, "club")) throw new NotFoundError();
  const parsed = z.object({ reward: z.string().regex(idRe) }).safeParse(req.body || {});
  if (!parsed.success) throw new BadInputError();
  // the same membership the club list shows (an unlinked record is not theirs)
  const c = await BizContact.findOne({ ownerKind: owner.kind, ownerId: oid(owner.id), user: oid(me(req)), isActive: { $ne: false } }).lean<IBizContact>();
  if (!c) throw new NotFoundError();
  const r = await redeemReward(owner, c._id, parsed.data.reward, req.user?._id, true);
  await fireFlows(owner, "club.redeemed", { type: "redemption", id: String(r._id), contact: c._id });
  res.status(201).json({ message: "myClubRedeem", data: { _id: r._id, code: r.code, name: r.name, expiresAt: r.expiresAt, points: r.points } });
});

// a code not yet used goes back (its points too)
const cancelCode = catchAsync(async (req: Request, res: Response) => {
  const owner = ownerOfParams(req);
  const c = await BizContact.findOne({ ownerKind: owner.kind, ownerId: oid(owner.id), user: oid(me(req)) }).lean<IBizContact>();
  if (!c || !isId(req.params.redemptionId)) throw new NotFoundError();
  const r = await BizClubRedemption.findOne({ _id: req.params.redemptionId, contact: c._id }).select("status").lean<{ status: string }>();
  if (!r) throw new NotFoundError();
  if (r.status !== "issued") throw new AppError("فقط کد استفاده‌نشده لغو می‌شود", 400);
  await cancelRedemption(owner, req.params.redemptionId, "patient", c._id);
  res.status(200).json({ message: "myClubCancel" });
});

// the centres the patient can write to: those they are a patient of
const getCentres = catchAsync(async (req: Request, res: Response) => {
  const contacts = await contactsOfMe(req);
  const out = await Promise.all(
    contacts.map(async (c) => ({ ownerKind: c.ownerKind, ownerId: c.ownerId, name: (await orgInfo(ownerOfContact(c)).catch(() => ({ name: "" }))).name })),
  );
  res.status(200).json({ message: "myCentres", data: out.filter((o) => o.name) });
});

const getTickets = catchAsync(async (req: Request, res: Response) => {
  const rows = await BizTicket.find({ user: oid(me(req)) }).sort({ lastMessageAt: -1 }).limit(200).lean<IBizTicket[]>();
  const names = new Map<string, string>();
  for (const r of rows) {
    const k = `${r.ownerKind}:${r.ownerId}`;
    if (!names.has(k)) names.set(k, (await orgInfo({ kind: r.ownerKind, id: String(r.ownerId) }).catch(() => ({ name: "" }))).name);
  }
  res.status(200).json({
    message: "myCentreTickets",
    data: rows.map((r) => ({ ...publicTicket(r), messages: undefined, centre: names.get(`${r.ownerKind}:${r.ownerId}`) || "", lastFromPatient: r.messages?.filter((m) => !m.internal).slice(-1)[0]?.fromPatient ?? true })),
  });
});

const getTicket = catchAsync(async (req: Request, res: Response) => {
  if (!isId(req.params.ticketId)) throw new NotFoundError();
  const t = await BizTicket.findOne({ _id: req.params.ticketId, user: oid(me(req)) }).lean<IBizTicket>();
  if (!t) throw new NotFoundError();
  const info = await orgInfo({ kind: t.ownerKind, id: String(t.ownerId) }).catch(() => ({ name: "" }));
  res.status(200).json({ message: "myCentreTicket", data: { ...publicTicket(t), centre: info.name } });
});

const createTicket = catchAsync(async (req: Request, res: Response) => {
  const owner = ownerOfParams(req);
  const parsed = z
    .object({ subject: z.string().trim().min(2).max(200), body: z.string().trim().min(2).max(5000), category: z.enum(bizTicketCategories).default("question") })
    .safeParse(req.body || {});
  if (!parsed.success) throw new AppError("موضوع و متن درخواست را بنویسید", 400);
  const c = await BizContact.findOne({ ownerKind: owner.kind, ownerId: oid(owner.id), user: oid(me(req)) }).lean<IBizContact>();
  if (!c) throw new AppError("فقط به مرکزی که در آن نوبت یا خرید داشته‌اید پیام می‌دهید", 400);
  // at most five open requests to one centre at a time
  if ((await BizTicket.countDocuments({ ownerKind: owner.kind, ownerId: oid(owner.id), user: oid(me(req)), status: { $in: ["open", "pending"] } })) >= 5)
    throw new AppError("چند درخواست باز به این مرکز دارید؛ پس از پاسخ آن‌ها درخواست تازه بفرستید", 400);
  const now = Date.now();
  const priority = parsed.data.category === "complaint" ? "high" : "normal";
  const sla = computeSla(priority, now);
  const assignee = await pickAssignee(owner);
  const t = await BizTicket.create({
    ownerKind: owner.kind,
    ownerId: oid(owner.id),
    number: await nextDocNumber("bizTicket", owner),
    subject: parsed.data.subject,
    category: parsed.data.category,
    priority,
    status: "open",
    contact: c._id,
    user: req.user?._id,
    ...(assignee ? { assignee } : {}),
    responseDueAt: new Date(sla.responseDueMs),
    resolveDueAt: new Date(sla.resolveDueMs),
    messages: [{ body: parsed.data.body, fromPatient: true, internal: false, author: req.user?._id }],
    lastMessageAt: new Date(now),
    openedBy: req.user?._id,
  });
  if (assignee) await notify(assignee, "درخواست تازه از بیمار", `درخواست شماره‌ی ${t.number.toLocaleString("fa-IR")}: «${t.subject}»`, crmLink(owner, `tickets/${t._id}`));
  await fireFlows(owner, "ticket.created", { type: "ticket", id: String(t._id), contact: c._id });
  res.status(201).json({ message: "myCentreTicketCreate", data: publicTicket(t.toObject() as IBizTicket) });
});

// the patient writes again: a resolved one opens again
const replyTicket = catchAsync(async (req: Request, res: Response) => {
  if (!isId(req.params.ticketId)) throw new NotFoundError();
  const parsed = z.object({ body: z.string().trim().min(1).max(5000) }).safeParse(req.body || {});
  if (!parsed.success) throw new AppError("متن پیام را بنویسید", 400);
  const t = await BizTicket.findOne({ _id: req.params.ticketId, user: oid(me(req)) }).lean<IBizTicket>();
  if (!t) throw new NotFoundError();
  if (t.status === "closed") throw new AppError("این درخواست بسته شده است", 400);
  const now = new Date();
  const out = await BizTicket.findOneAndUpdate(
    { _id: t._id },
    { $push: { messages: { body: parsed.data.body, fromPatient: true, internal: false, author: req.user?._id, at: now } }, $set: { status: "open", lastMessageAt: now }, $unset: { resolvedAt: 1 } },
    { new: true },
  ).lean<IBizTicket>();
  const owner = { kind: t.ownerKind, id: String(t.ownerId) } as BizOwner;
  if (t.assignee) await notify(t.assignee, "پیام تازه از بیمار", `درخواست شماره‌ی ${t.number.toLocaleString("fa-IR")}: «${t.subject}»`, crmLink(owner, `tickets/${t._id}`));
  res.status(200).json({ message: "myCentreTicketReply", data: out ? publicTicket(out) : null });
});

// the patient closes it (done); the team member on it is told
const closeTicket = catchAsync(async (req: Request, res: Response) => {
  if (!isId(req.params.ticketId)) throw new NotFoundError();
  const before = await BizTicket.findOne({ _id: req.params.ticketId, user: oid(me(req)) }).select("status resolvedAt").lean<IBizTicket>();
  if (!before) throw new NotFoundError();
  if (before.status === "closed") throw new AppError("این درخواست بسته شده است", 400);
  const t = await BizTicket.findOneAndUpdate(
    { _id: req.params.ticketId, user: oid(me(req)), status: before.status },
    { $set: { status: "closed", ...(before.resolvedAt ? {} : { resolvedAt: new Date() }) } },
    { new: true },
  ).lean<IBizTicket>();
  if (!t) throw new AppError("این درخواست بسته شده است", 400);
  const owner = { kind: t.ownerKind, id: String(t.ownerId) } as BizOwner;
  if (t.assignee) await notify(t.assignee, "درخواست را بیمار بست", `درخواست شماره‌ی ${t.number.toLocaleString("fa-IR")}: «${t.subject}»`, crmLink(owner, `tickets/${t._id}`));
  res.status(200).json({ message: "myCentreTicketClose", data: publicTicket(t) });
});

// ---------------------------------------------------------------- record linking
// (2026-10, Lib/business/crmService/link.ts) - the centres' hand-added,
// imported and web-form contacts of the user's verified phone, offered for
// the user to link; nothing is linked without the patient's own act.

// offers waiting for an answer: the centre's name and kind only
const getLinkOffers = catchAsync(async (req: Request, res: Response) => {
  rateLimit(`linkRead:${me(req)}`, 120);
  await refreshOffers(req.user!, metaOf(req));
  res.status(200).json({ message: "myLinkOffers", data: await pendingOffers(req.user!) });
});

const actOnOffer = (fn: (user: { _id: unknown; phone?: string }, offerId: string, meta: Meta) => Promise<unknown>) =>
  catchAsync(async (req: Request, res: Response) => {
    rateLimit(`linkAct:${me(req)}`, 30);
    const out = await fn(req.user!, String(req.params.offerId || ""), metaOf(req));
    res.status(200).json({ message: "myLinkOffer", data: out });
  });

const getLinks = catchAsync(async (req: Request, res: Response) => {
  rateLimit(`linkRead:${me(req)}`, 120);
  res.status(200).json({ message: "myLinks", data: await linksOf(me(req)) });
});

const unlink = catchAsync(async (req: Request, res: Response) => {
  rateLimit(`linkAct:${me(req)}`, 30);
  res.status(200).json({ message: "myUnlink", data: await unlinkContact(req.user!, String(req.params.contactId || ""), metaOf(req)) });
});

const getConsentLog = catchAsync(async (req: Request, res: Response) => {
  rateLimit(`linkRead:${me(req)}`, 120);
  res.status(200).json({ message: "myConsentLog", data: await historyOf(me(req)) });
});

export const userCrmRouter = express.Router();
userCrmRouter.get("/link-offers", getLinkOffers);
userCrmRouter.post("/link-offers/:offerId/link", actOnOffer(linkOffer));
userCrmRouter.post("/link-offers/:offerId/decline", actOnOffer(declineOffer));
userCrmRouter.post("/link-offers/:offerId/later", actOnOffer(snoozeOffer));
userCrmRouter.get("/links", getLinks);
userCrmRouter.post("/links/:contactId/unlink", unlink);
userCrmRouter.get("/consent-log", getConsentLog);
userCrmRouter.get("/clubs", getClubs);
userCrmRouter.post("/clubs/:ownerKind/:ownerId/redeem", redeem);
userCrmRouter.post("/clubs/:ownerKind/:ownerId/codes/:redemptionId/cancel", cancelCode);
userCrmRouter.get("/centres", getCentres);
userCrmRouter.get("/tickets", getTickets);
userCrmRouter.get("/tickets/:ticketId", getTicket);
userCrmRouter.post("/centres/:ownerKind/:ownerId/tickets", createTicket);
userCrmRouter.post("/tickets/:ticketId/reply", replyTicket);
userCrmRouter.post("/tickets/:ticketId/close", closeTicket);
