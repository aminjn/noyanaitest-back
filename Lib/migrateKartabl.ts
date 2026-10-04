import mongoose from "mongoose";

// Boot migration (2026-10): the three approval stores become the one
// «کارتابل» (Models/BizRequest.ts, Lib/business/kartabl.ts).
//   bizapprovals  (CRM sales: plan, discount, credit) -> a BizRequest each,
//                 same _id (a plan's approval.request still points at it),
//                 "applied" -> "done";
//   bizinboxtasks (CRM engagement inbox): a workflow step -> a "flow" item,
//                 same _id; a return's level tasks -> folded into the
//                 return's own item (below);
//   bizreturns    -> one "return" item each (its chain, level and reason move
//                 there; the return keeps its own status);
//   bizrequests   of the old finance kind "return" -> a BizReturn each (the
//                 one owner of credit notes), linked to its item.
// Then the two old collections are dropped. Idempotent (upserts by _id) and
// run once (the marker).
const MARKER = "business-kartabl-merge";

type Doc = Record<string, unknown> & { _id: mongoose.Types.ObjectId };
type Decision = { by?: unknown; name?: string; level: number; decision: string; note?: string; at: Date };

export const migrateKartabl = async () => {
  const db = mongoose.connection.db;
  if (!db) return;
  const marks = db.collection<{ _id: string; at: Date }>("bootmigrations");
  if (await marks.findOne({ _id: MARKER })) return;
  const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const requests = db.collection<Doc>("bizrequests");
  const returns = db.collection<Doc>("bizreturns");
  const counters = db.collection<{ _id: string; seq: number }>("bizcounters");
  const stats = { sales: 0, flow: 0, returns: 0, financeReturns: 0 };
  const put = (doc: Doc) => requests.replaceOne({ _id: doc._id }, doc, { upsert: true });
  const bump = async (key: string, n: number) => {
    await counters.updateOne({ _id: key }, { $max: { seq: n } }, { upsert: true });
  };

  // 1. CRM sales approvals
  if (names.has("bizapprovals")) {
    for (const a of await db.collection<Doc>("bizapprovals").find().toArray()) {
      const decisions = ((a.decisions as Decision[]) || []).map((d) => ({ ...d, level: typeof d.level === "number" ? d.level : Number(a.level) || 0 }));
      const last = decisions[decisions.length - 1];
      await put({
        _id: a._id,
        ownerKind: a.ownerKind,
        ownerId: a.ownerId,
        kind: a.kind,
        number: a.number,
        requester: a.requester,
        contact: a.contact,
        plan: a.plan,
        invoice: a.invoice,
        amount: a.amount || 0,
        percent: a.percent || 0,
        requestedLimit: a.requestedLimit || 0,
        description: a.description,
        status: a.status === "applied" ? "done" : a.status,
        chain: a.chain || [],
        chainNames: [],
        level: a.level || 0,
        decisions,
        ...(last ? { decidedAt: last.at } : {}),
        ...(a.status === "rejected" && last?.note ? { rejectReason: last.note } : {}),
        ...(a.appliedAt ? { executedAt: a.appliedAt } : {}),
        createdAt: a.createdAt,
        updatedAt: a.updatedAt || new Date(),
        __v: 0,
      } as Doc);
      stats.sales++;
    }
  }

  // 2. workflow steps (and the return tasks, kept for step 3)
  const returnTasks = new Map<string, Doc[]>();
  if (names.has("bizinboxtasks")) {
    const tasks = await db.collection<Doc>("bizinboxtasks").find().sort({ createdAt: 1 }).toArray();
    for (const t of tasks) {
      if (t.entityType === "return") {
        const list = returnTasks.get(String(t.entityId)) || [];
        list.push(t);
        returnTasks.set(String(t.entityId), list);
        continue;
      }
      if (t.entityType !== "flow") continue;
      const key = `request:flow:${t.ownerKind}:${t.ownerId || ""}`;
      const n = (await counters.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" }))?.seq || 1;
      const decided = t.status === "approved" || t.status === "rejected";
      await put({
        _id: t._id,
        ownerKind: t.ownerKind,
        ownerId: t.ownerId,
        kind: "flow",
        number: n,
        title: t.title,
        detail: t.detail,
        run: t.run,
        step: t.step,
        amount: 0,
        percent: 0,
        requestedLimit: 0,
        // an approved step already moved its run on
        status: t.status === "approved" ? "done" : t.status,
        chain: [t.approver],
        chainNames: [],
        level: 0,
        decisions: decided ? [{ by: t.approver, level: 0, decision: t.status, note: t.note, at: t.decidedAt || t.updatedAt }] : [],
        ...(decided ? { decidedAt: t.decidedAt || t.updatedAt } : {}),
        ...(t.status === "rejected" && t.note ? { rejectReason: t.note } : {}),
        ...(t.status === "approved" ? { executedAt: t.decidedAt || t.updatedAt } : {}),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt || new Date(),
        __v: 0,
      } as Doc);
      stats.flow++;
    }
  }

  // 3. every return gets its item; its chain moves there
  const RETURN_STATUS: Record<string, string> = { pending: "pending", approved: "approved", processed: "done", voided: "done", rejected: "rejected", cancelled: "cancelled" };
  for (const r of await returns.find().toArray()) {
    if (await requests.findOne({ returnDoc: r._id })) continue;
    const tasks = returnTasks.get(String(r._id)) || [];
    const decisions = tasks
      .filter((t) => t.status === "approved" || t.status === "rejected")
      .map((t) => ({ by: t.approver, level: Number(t.level) || 0, decision: t.status, note: t.note, at: t.decidedAt || t.updatedAt }));
    const last = decisions[decisions.length - 1];
    await put({
      _id: new mongoose.Types.ObjectId(),
      ownerKind: r.ownerKind,
      ownerId: r.ownerId,
      kind: "return",
      number: r.number,
      requester: r.requester,
      returnDoc: r._id,
      contact: r.contact,
      invoice: r.invoice,
      amount: r.amount || 0,
      percent: 0,
      requestedLimit: 0,
      description: r.reason,
      status: RETURN_STATUS[String(r.status)] || "pending",
      chain: r.approverChain || [],
      chainNames: [],
      level: r.currentLevel || 0,
      decisions,
      ...(last ? { decidedAt: last.at } : {}),
      ...(r.rejectReason ? { rejectReason: r.rejectReason } : {}),
      ...(r.processedAt ? { executedAt: r.processedAt, voucherRef: r.voucherRef || r.stockRef } : {}),
      createdAt: r.createdAt,
      updatedAt: new Date(),
      __v: 0,
    } as Doc);
    stats.returns++;
  }
  await returns.updateMany({}, { $unset: { approverChain: 1, currentLevel: 1, rejectReason: 1 } });

  // 4. the finance desk's old "return" kind becomes a return of its own
  const RET_OF_REQ: Record<string, string> = { pending: "pending", approved: "approved", done: "processed", rejected: "rejected", cancelled: "cancelled" };
  for (const q of await requests.find({ kind: "return", returnDoc: { $exists: false } }).toArray()) {
    if (!q.ownerId) continue;
    const key = `bizReturn:${q.ownerKind}:${q.ownerId}`;
    const n = (await counters.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" }))?.seq || 1;
    const retId = new mongoose.Types.ObjectId();
    await returns.insertOne({
      _id: retId,
      ownerKind: q.ownerKind,
      ownerId: q.ownerId,
      number: n,
      kind: "service",
      action: "credit",
      ...(q.invoice ? { invoice: q.invoice } : {}),
      amount: q.amount || 0,
      payFrom: "cash",
      reason: [q.invoiceRef, q.partyName, q.description].filter(Boolean).join(" · ").slice(0, 1000) || undefined,
      status: RET_OF_REQ[String(q.status)] || "pending",
      requester: q.requester,
      ...(q.voucherRef ? { voucherRef: q.voucherRef } : {}),
      ...(q.executedAt ? { processedAt: q.executedAt } : {}),
      createdAt: q.createdAt,
      updatedAt: new Date(),
      __v: 0,
    } as Doc);
    await requests.updateOne({ _id: q._id }, { $set: { returnDoc: retId, number: n } });
    stats.financeReturns++;
  }

  // the counters go on from the highest number each kind has
  for (const row of await requests.aggregate<{ _id: { k: string; o: string; i: unknown }; n: number }>([{ $group: { _id: { k: "$kind", o: "$ownerKind", i: "$ownerId" }, n: { $max: "$number" } } }]).toArray()) {
    const k = row._id.k;
    if (k === "return") continue;
    const prefix = ["plan", "discount", "credit"].includes(k) ? `crmApproval:${k}` : `request:${k}`;
    await bump(`${prefix}:${row._id.o}:${row._id.i ? String(row._id.i) : ""}`, row.n);
  }

  if (names.has("bizapprovals")) await db.collection("bizapprovals").drop().catch(() => undefined);
  if (names.has("bizinboxtasks")) await db.collection("bizinboxtasks").drop().catch(() => undefined);
  await marks.insertOne({ _id: MARKER, at: new Date() });
  console.log(`[kartabl] merged ${stats.sales} sales approvals, ${stats.flow} workflow steps, ${stats.returns} returns, ${stats.financeReturns} finance returns`);
};
