import BizSequence, { IBizSequence } from "../../../Models/BizSequence";
import BizSequenceEnrollment, { IBizSequenceEnrollment } from "../../../Models/BizSequenceEnrollment";
import BizContact, { IBizContact } from "../../../Models/BizContact";
import BizActivity from "../../../Models/BizActivity";
import AppError from "../../AppError";
import { BizOwner } from "../coa";
import { crmLink, DAY, fill, HOUR, notify, oid, own, ownerOfDoc, ownerUser } from "./common";
import { sendTemplateToContact } from "./sms";

// Sequences (2026-10), nexxacrm's crm/sequences + scheduler.ts
// processSequences: a patient enrolled walks the steps, each `waitDays`
// after the previous; a job runs the steps that fell due. Nothing runs
// while the sequence is switched off (its patients wait where they are).

export const MAX_BULK = 2000;

export const addDays = (d: Date, n: number) => new Date(+d + Math.max(0, n) * DAY);

// Patients into a sequence: only the owner's, never twice while active.
export const enrollContacts = async (owner: BizOwner, sequenceId: unknown, contactIds: unknown[], by?: unknown, source?: string) => {
  const seq = await BizSequence.findOne({ ...own(owner), _id: oid(sequenceId) }).lean<IBizSequence>();
  if (!seq) throw new AppError("این پیام زنجیره‌ای پیدا نشد", 404);
  if (!seq.steps.length) throw new AppError("پیام زنجیره‌ای دست‌کم یک قدم لازم دارد", 400);
  const ids = Array.from(new Set(contactIds.map(String))).slice(0, MAX_BULK);
  const contacts = await BizContact.find({ ...own(owner), _id: { $in: ids.map(oid) }, isActive: { $ne: false } }).select("_id").lean();
  const active = new Set(
    (await BizSequenceEnrollment.find({ sequence: seq._id, contact: { $in: contacts.map((c) => c._id) }, status: "active" }).select("contact").lean()).map((e) =>
      String(e.contact),
    ),
  );
  const fresh = contacts.filter((c) => !active.has(String(c._id)));
  const now = new Date();
  const docs = fresh.map((c) => ({
    ...own(owner),
    sequence: seq._id,
    contact: c._id,
    status: "active",
    currentStep: 0,
    nextRunAt: addDays(now, seq.steps[0].waitDays),
    log: [],
    ...(source ? { source } : {}),
    createdBy: by,
  }));
  let enrolled = 0;
  if (docs.length) {
    const res = await BizSequenceEnrollment.insertMany(docs, { ordered: false }).catch((err: { insertedDocs?: unknown[] }) => err.insertedDocs || []);
    enrolled = Array.isArray(res) ? res.length : 0;
  }
  return { enrolled, skipped: ids.length - enrolled };
};

export const stopEnrollment = async (owner: BizOwner, id: unknown) => {
  const r = await BizSequenceEnrollment.updateOne({ ...own(owner), _id: oid(id), status: "active" }, { $set: { status: "stopped", stoppedAt: new Date() }, $unset: { nextRunAt: 1 } });
  if (!r.modifiedCount) throw new AppError("این ثبت‌نام فعال نیست", 400);
};

// one step of one enrollment
const runStep = async (enr: IBizSequenceEnrollment, seq: IBizSequence) => {
  const owner = ownerOfDoc(enr);
  const step = seq.steps[enr.currentStep];
  const c = await BizContact.findOne({ ...own(owner), _id: enr.contact }).lean<IBizContact>();
  const log = (result: IBizSequenceEnrollment["log"][number]["result"], reason?: string) => ({ step: enr.currentStep, at: new Date(), result, ...(reason ? { reason } : {}) });
  if (!c) return { advance: true, entry: log("skipped", "contact") };
  const text = fill(step.text || seq.name, { name: c.name || "", firstName: (c.name || "").split(/\s+/)[0] || "", phone: c.phone }).slice(0, 1000);
  if (step.channel === "sms") {
    const r = await sendTemplateToContact(owner, c, step.template, { source: "sequence", dedupeKey: `seq:${enr._id}:${enr.currentStep}` });
    if (r.ok) return { advance: true, entry: log("sent") };
    // outside the send window, or no credit yet: the same step, later
    if (r.reason === "window" || r.reason === "noCredit") return { advance: false, retryAt: new Date(Date.now() + HOUR), entry: log("waiting", r.reason) };
    return { advance: true, entry: log(r.reason === "duplicate" ? "sent" : "skipped", r.reason) };
  }
  if (step.channel === "task") {
    const assignee = step.assignee || (await ownerUser(owner));
    await BizActivity.create({ ...own(owner), contact: c._id, kind: "followUp", text, dueAt: new Date(), ...(assignee ? { assignee } : {}) });
    return { advance: true, entry: log("task") };
  }
  await BizActivity.create({ ...own(owner), contact: c._id, kind: "note", text });
  return { advance: true, entry: log("note") };
};

const MAX_PER_RUN = 300;
export const runSequenceSweep = async () => {
  const now = new Date();
  const due = await BizSequenceEnrollment.find({ status: "active", nextRunAt: { $lte: now } }).sort({ nextRunAt: 1 }).limit(MAX_PER_RUN).lean<IBizSequenceEnrollment[]>();
  const seqs = new Map<string, IBizSequence | null>();
  for (const enr of due) {
    // claim: move nextRunAt far ahead so another run can't take it
    const claim = await BizSequenceEnrollment.updateOne({ _id: enr._id, status: "active", nextRunAt: enr.nextRunAt }, { $set: { nextRunAt: addDays(now, 3650) } });
    if (!claim.modifiedCount) continue;
    const key = String(enr.sequence);
    if (!seqs.has(key)) seqs.set(key, await BizSequence.findById(enr.sequence).lean<IBizSequence>());
    const seq = seqs.get(key);
    if (!seq || enr.currentStep >= seq.steps.length) {
      await BizSequenceEnrollment.updateOne({ _id: enr._id }, { $set: { status: "completed", completedAt: now }, $unset: { nextRunAt: 1 } });
      continue;
    }
    // switched off: wait a day and look again
    if (!seq.active) {
      await BizSequenceEnrollment.updateOne({ _id: enr._id }, { $set: { nextRunAt: addDays(now, 1) } });
      continue;
    }
    try {
      const r = await runStep(enr, seq);
      if (!r.advance) {
        const last = enr.log[enr.log.length - 1];
        const same = last && last.step === enr.currentStep && last.result === "waiting";
        await BizSequenceEnrollment.updateOne({ _id: enr._id }, { $set: { nextRunAt: r.retryAt }, ...(same ? {} : { $push: { log: r.entry } }) });
        continue;
      }
      const next = enr.currentStep + 1;
      if (next >= seq.steps.length) {
        await BizSequenceEnrollment.updateOne(
          { _id: enr._id },
          { $set: { status: "completed", completedAt: new Date(), currentStep: next }, $unset: { nextRunAt: 1 }, $push: { log: r.entry } },
        );
        const { fireFlows } = await import("./flow");
        await fireFlows(ownerOfDoc(enr), "sequence.completed", { type: "enrollment", id: String(enr._id), contact: enr.contact }).catch(() => {});
      } else
        await BizSequenceEnrollment.updateOne(
          { _id: enr._id },
          { $set: { currentStep: next, nextRunAt: addDays(new Date(), seq.steps[next].waitDays) }, $push: { log: r.entry } },
        );
    } catch (err) {
      console.log(`[crm] sequence step ${enr._id} failed:`, err);
      await BizSequenceEnrollment.updateOne(
        { _id: enr._id },
        { $set: { nextRunAt: new Date(Date.now() + HOUR) }, $push: { log: { step: enr.currentStep, at: new Date(), result: "failed" } } },
      );
    }
  }
};

export const sequenceLink = (owner: BizOwner) => crmLink(owner, "sequences");
export { notify };
