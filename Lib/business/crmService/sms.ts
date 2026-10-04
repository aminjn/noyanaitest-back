import mongoose from "mongoose";
import BizTemplate, { IBizTemplate } from "../../../Models/BizTemplate";
import { IBizContact } from "../../../Models/BizContact";
import BizMessage from "../../../Models/BizMessage";
import Wallet from "../../../Models/Wallet";
import { BizOwner } from "../coa";
import { giveQuota, inOwnWindow, monthlyQuota, orgInfo, takeQuota, unitPrice, varsFor, walletTx } from "../campaign";
import { messageFor, newTrackedLink, orgPublicUrl, randomCode, renderText, sendOne, siteBase, smsParts, trackedUrl } from "../crmSend";
import { own } from "./common";

// One approved template to one patient (2026-10), for a sequence step or
// a workflow action - the same rules as the one-off SMS from a contact's
// page (Controllers/crmEngageController.ts sendToContact): an approved
// template only, never to someone who opted out, inside the send window,
// paid from the plan's quota first and then the wallet, recorded before
// the gateway is called under a unique key, and paid back if it fails.
//
// The result's reason tells the caller what to do: "window" and "noCredit"
// can be tried again later; the others cannot.
export type SendResult = { ok: true; parts: number } | { ok: false; reason: "template" | "optedOut" | "window" | "noCredit" | "duplicate" | "gateway" };

export const sendTemplateToContact = async (
  owner: BizOwner,
  c: IBizContact,
  templateId: unknown,
  meta: { source: "sequence" | "flow"; dedupeKey: string },
): Promise<SendResult> => {
  const t = templateId ? await BizTemplate.findOne({ ...own(owner), _id: templateId }).lean<IBizTemplate>() : null;
  if (!t || t.status !== "Approved") return { ok: false, reason: "template" };
  if (c.smsOptOut || !c.isActive) return { ok: false, reason: "optedOut" };
  if (await mongoose.model("SmsOptOut").exists({ phone: c.phone })) return { ok: false, reason: "optedOut" };
  if (!inOwnWindow()) return { ok: false, reason: "window" };
  if (await BizMessage.exists({ dedupeKey: meta.dedupeKey })) return { ok: false, reason: "duplicate" };
  const [info, base] = await Promise.all([orgInfo(owner), siteBase()]);
  const code = randomCode(6);
  let link = "";
  if (/\{(link|review)\}/.test(t.text)) {
    const token = await newTrackedLink(await orgPublicUrl(owner, base));
    link = token ? trackedUrl(base, token, code) : "";
  }
  const body = messageFor(renderText(t.text, varsFor(c, info.name, link)), base, c.optCode);
  const parts = smsParts(body);
  const price = await unitPrice();
  const fromQuota = await takeQuota(owner, parts, await monthlyQuota(owner));
  const cost = (parts - fromQuota) * price;
  if (cost > 0) {
    const debited = await Wallet.findOneAndUpdate({ user: info.user, balance: { $gte: cost } }, { $inc: { balance: -cost } });
    if (!debited) {
      await giveQuota(owner, fromQuota);
      return { ok: false, reason: "noCredit" };
    }
  }
  const refund = async () => {
    if (cost > 0) await Wallet.updateOne({ user: info.user }, { $inc: { balance: cost } });
    await giveQuota(owner, fromQuota);
  };
  const row = await BizMessage.create({
    ...own(owner),
    contact: c._id,
    phone: c.phone,
    source: meta.source,
    template: t._id,
    dedupeKey: meta.dedupeKey,
    text: body,
    parts,
    code,
  }).catch(() => null);
  if (!row) {
    await refund();
    return { ok: false, reason: "duplicate" };
  }
  const r = await sendOne(c.phone, body);
  await BizMessage.updateOne({ _id: row._id }, { $set: r.ok ? { status: "sent", sentAt: new Date(), outboxId: r.outboxId } : { status: "failed", reason: "gateway" } });
  if (!r.ok) {
    await refund();
    return { ok: false, reason: "gateway" };
  }
  if (cost > 0) await walletTx(owner, row._id, info.user, -cost, "smsMessage").catch(() => {});
  return { ok: true, parts };
};
