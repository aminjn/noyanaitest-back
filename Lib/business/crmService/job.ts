import BizTask, { IBizTask } from "../../../Models/BizTask";
import { crmLink, notify, ownerOfDoc } from "./common";
import { runSequenceSweep } from "./sequence";
import { runFlowSweep } from "./flow";
import { runTicketSweep } from "./tickets";
import { reconcileRedemptions } from "./club";

// The job of the CRM's engagement and service side (2026-10), every five
// minutes, beside the ready-made automations' job (Lib/business/
// crmAutomation.ts): sequence steps that fell due, workflow delays and
// polled triggers, ticket SLA breaches, task due dates, and club codes
// that expired or whose invoice moved on.

// a task's due date told to its assignee once
const remindTasks = async () => {
  const due = await BizTask.find({ done: false, remindedAt: { $exists: false }, dueAt: { $lte: new Date() }, assignee: { $exists: true } }).limit(200).lean<IBizTask[]>();
  for (const t of due) {
    const claimed = await BizTask.updateOne({ _id: t._id, remindedAt: { $exists: false } }, { $set: { remindedAt: new Date() } });
    if (claimed.modifiedCount) await notify(t.assignee, "موعد کار رسید", `«${t.title}»`, crmLink(ownerOfDoc(t), `tasks/${t.project}`));
  }
};

let running = false;
export const runCrmServiceSweep = async () => {
  if (running) return;
  running = true;
  try {
    for (const [name, fn] of [
      ["sequences", runSequenceSweep],
      ["flows", runFlowSweep],
      ["tickets", runTicketSweep],
      ["tasks", remindTasks],
      ["club", () => reconcileRedemptions()],
    ] as const)
      await fn().catch((err: unknown) => console.log(`[crm] ${name} sweep failed:`, err));
  } finally {
    running = false;
  }
};

export const startCrmServiceJob = () => {
  setInterval(() => runCrmServiceSweep().catch((err) => console.log("[crm] service sweep failed:", err)), 5 * 60_000);
};
