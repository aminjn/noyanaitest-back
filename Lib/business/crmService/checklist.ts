import { BizRepeat } from "../../../Models/BizChecklistItem";

// nexxacrm's checklist `advance`: the due date of a repeating item's next
// one (pure). Monthly keeps the day, clamped to the month's last day.
export const advanceDue = (due: Date, repeat: BizRepeat): Date | null => {
  const d = new Date(due);
  if (repeat === "daily") return new Date(+d + 864e5);
  if (repeat === "weekly") return new Date(+d + 7 * 864e5);
  if (repeat === "monthly") {
    const day = d.getUTCDate();
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, d.getUTCHours(), d.getUTCMinutes()));
    const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, last));
    return next;
  }
  return null;
};
