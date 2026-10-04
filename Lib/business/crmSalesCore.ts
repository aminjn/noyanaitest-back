// Pure cores of the CRM sales side (2026-10, docs/nexxa-crm-parity.md in
// the frontend repo), ported from Nexxa's src/lib: rules.ts (conditions),
// commission-core.ts (tiers), assign.ts / territory.ts (least-loaded
// assignee), sales-planner-core.ts (day plan ranking, refill cadence),
// goals.ts (pace), the proposal totals, the stage blueprint and the
// duplicate grouping of merge. No database here: Lib/business/crmSales.ts
// feeds them, Lib/business/__tests__/crmSalesCore.test.ts proves them.

export const DAY = 86_400_000;

const toLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

// ---------------------------------------------------------------- conditions

export type Condition = { field: string; op: string; value: string };
export const condOps = ["eq", "neq", "contains", "in", "gt", "lt", "empty", "notempty"] as const;
export type FieldType = "text" | "number" | "bool" | "select";

// the fields a score / assignment rule may test, on a lead (with its
// patient's figures copied in as contact*)
export const leadFields: Record<string, FieldType> = {
  title: "text",
  kind: "select",
  status: "select",
  sourceName: "text",
  priority: "number",
  value: "number",
  probability: "number",
  contactVisits: "number",
  contactSpent: "number",
  contactInsurer: "select",
  contactCity: "text",
  contactGender: "select",
  contactAge: "number",
};

const fieldValue = (record: Record<string, unknown>, key: string) => {
  const v = record?.[key];
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
};

const normBool = (s: string) => {
  const t = s.trim().toLowerCase();
  if (["true", "بله", "بلی", "1", "yes", "y", "دارد", "on"].includes(t)) return "true";
  if (["false", "خیر", "نه", "0", "no", "n", "ندارد", "off"].includes(t)) return "false";
  return t;
};

export const matchCondition = (record: Record<string, unknown>, c: Condition, types: Record<string, FieldType> = leadFields): boolean => {
  const isBool = types[c.field] === "bool";
  let v = toLatin(fieldValue(record, c.field)).trim();
  let target = toLatin(c.value ?? "").trim();
  if (isBool) {
    v = normBool(v);
    target = normBool(target);
  }
  const lv = v.toLowerCase();
  const lt = target.toLowerCase();
  switch (c.op) {
    case "eq":
      return lv === lt;
    case "neq":
      return lv !== lt;
    case "contains":
      return lv.includes(lt);
    case "in":
      return target
        .split(/[,،]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .includes(lv);
    case "gt":
      return v !== "" && Number(v) > Number(target);
    case "lt":
      return v !== "" && Number(v) < Number(target);
    case "empty":
      return v === "";
    case "notempty":
      return v !== "";
    default:
      return false;
  }
};

// every condition holds (AND); none is "always"
export const matchAll = (record: Record<string, unknown>, conditions: Condition[] | undefined | null, types?: Record<string, FieldType>) =>
  !Array.isArray(conditions) || !conditions.length || conditions.every((c) => matchCondition(record, c, types));

// the sum of the points of the active rules a record meets (Nexxa
// computeRuleScore); no rule = 0, never a stale score
export const ruleScore = (record: Record<string, unknown>, rules: { field: string; op: string; value: string; points: number; active?: boolean }[]) =>
  rules.reduce((s, r) => (r.active === false ? s : matchCondition(record, r) ? s + (Number(r.points) || 0) : s), 0);

// ---------------------------------------------------------------- commission

export type Tier = { from: number; pct: number };

// marginal: each slice at its own step's rate; whole: the highest step
// reached, on the whole amount
export const applyTiers = (base: number, tiers: Tier[], method: string): number => {
  if (base <= 0 || !tiers.length) return 0;
  const sorted = [...tiers].sort((a, b) => a.from - b.from);
  if (method === "whole") {
    let rate = 0;
    for (const t of sorted) if (base >= t.from) rate = t.pct;
    return Math.round((base * rate) / 100);
  }
  let commission = 0;
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i].from;
    if (base <= from) break;
    const upper = i + 1 < sorted.length ? sorted[i + 1].from : Infinity;
    const portion = Math.min(base, upper) - from;
    if (portion > 0) commission += (portion * sorted[i].pct) / 100;
  }
  return Math.round(commission);
};

export const commissionFor = (base: number, flatPct: number, tiers: Tier[], mode: string, method: string) =>
  mode === "tiered" && tiers.length ? applyTiers(base, tiers, method) : Math.round((base * (Number(flatPct) || 0)) / 100);

// ---------------------------------------------------------------- assignment

// the least-loaded member of a pool (fewest open records); a tie goes to
// the earlier one in the pool's own order (Nexxa pickAssignee)
export const pickLeastLoaded = (pool: string[], load: Map<string, number> | Record<string, number>): string | null => {
  if (!pool.length) return null;
  const get = (id: string) => (load instanceof Map ? load.get(id) : load[id]) ?? 0;
  let best = pool[0];
  let bestN = get(best);
  for (const id of pool) {
    const n = get(id);
    if (n < bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
};

// ---------------------------------------------------------------- stages

export const stageFields = ["title", "value", "expectedClose", "contact", "probability", "assignee", "items"] as const;
export type StageField = (typeof stageFields)[number];

// the fields a stage's blueprint asks for that the lead lacks, and whether
// a logged activity is missing (empty = the lead may enter)
export const stageMissing = (
  lead: Partial<Record<StageField, unknown>>,
  rule: { requiredFields?: string[]; requireActivity?: boolean } | null | undefined,
  activityCount: number,
): string[] => {
  if (!rule) return [];
  const missing: string[] = [];
  for (const f of rule.requiredFields || []) {
    const v = lead[f as StageField];
    const empty = v === undefined || v === null || v === "" || (typeof v === "number" && v <= 0) || (Array.isArray(v) && !v.length);
    if (empty) missing.push(f);
  }
  if (rule.requireActivity && activityCount <= 0) missing.push("activity");
  return missing;
};

// ---------------------------------------------------------------- totals

export type PriceLine = { qty: number; unitPrice: number; discount?: number; taxRate?: number };

// a plan's (proposal's) totals: each line's own discount percent, then the
// plan's discount percent, then each line's tax; clamped like Nexxa
// (discount <= 100, tax <= 50)
export const planTotals = (lines: PriceLine[], discountPercent = 0) => {
  const head = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  const rows = lines.map((l) => {
    const qty = Math.max(0, Number(l.qty) || 0);
    const unit = Math.max(0, Math.round(Number(l.unitPrice) || 0));
    const gross = Math.round(qty * unit);
    const lineDisc = Math.min(100, Math.max(0, Number(l.discount) || 0));
    const afterLine = gross - Math.round((gross * lineDisc) / 100);
    const net = afterLine - Math.round((afterLine * head) / 100);
    const rate = Math.min(50, Math.max(0, Number(l.taxRate) || 0));
    const t = Math.round((net * rate) / 100);
    subtotal += gross;
    discount += gross - net;
    tax += t;
    return { gross, net, tax: t };
  });
  return { rows, subtotal, discount, tax, total: subtotal - discount + tax };
};

// ---------------------------------------------------------------- periods

// the next due date of a care plan (subscription): n months or years on,
// the day kept (clamped to the month's end)
export const advancePeriod = (d: Date, interval: "week" | "month" | "year", count = 1) => {
  const n = Math.max(1, Math.floor(count) || 1);
  if (interval === "week") return new Date(d.getTime() + n * 7 * DAY);
  const months = interval === "year" ? 12 * n : n;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
};

// a goal's period from its kind, from a date
export const periodRange = (period: string, now = new Date()) => {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (period === "year") return { start: new Date(y, 0, 1), end: new Date(y, 11, 31, 23, 59, 59) };
  if (period === "quarter") {
    const q = Math.floor(m / 3) * 3;
    return { start: new Date(y, q, 1), end: new Date(y, q + 3, 0, 23, 59, 59) };
  }
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 0, 23, 59, 59) };
};

// ---------------------------------------------------------------- planner

export const purchaseCadence = (datesMs: number[]) => {
  const sorted = [...datesMs].sort((a, b) => a - b);
  if (sorted.length < 2) return 45;
  let sum = 0;
  for (let i = 1; i < sorted.length; i++) sum += (sorted[i] - sorted[i - 1]) / DAY;
  return Math.max(7, Math.round(sum / (sorted.length - 1)));
};

export const dueInDaysFor = (lastDateMs: number, cadenceDays: number, nowMs: number) => Math.round((lastDateMs + cadenceDays * DAY - nowMs) / DAY);

export const isReorderDue = (count: number, dueInDays: number, cadenceDays: number) => {
  const overdue = -dueInDays;
  if (dueInDays > 10) return false;
  if (count === 1 && overdue > cadenceDays) return false;
  if (count >= 2 && overdue > cadenceDays * 2) return false;
  return true;
};

export const expectedPacePct = (startMs: number, nowMs: number, endMs: number) => {
  const total = Math.max(1, Math.ceil((endMs - startMs) / DAY));
  const elapsed = Math.max(0, Math.min(total, Math.ceil((nowMs - startMs) / DAY)));
  return Math.round((elapsed / total) * 100);
};

export const leadTaskScore = (idleDays: number, value: number, leadScore: number, probability: number) => {
  let s = 0;
  if (idleDays >= 7) s += 30;
  else if (idleDays >= 3) s += 15;
  s += Math.min(30, Math.log10(Math.max(1, value)) * 4);
  s += (Math.max(0, Math.min(100, leadScore)) / 100) * 25;
  s += (Math.max(0, Math.min(100, probability)) / 100) * 15;
  return s;
};

export const priorityFromScore = (score: number) => (score >= 45 ? 1 : score >= 25 ? 2 : 3);

// ---------------------------------------------------------------- duplicates

export type DupCandidate = { id: string; name?: string; nationalId?: string; user?: string; birthYear?: number };

const normName = (s?: string) =>
  toLatin(s || "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ً-ْ‌‏]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// groups of probable duplicates: the same national id, the same Noyan
// account, or the same name with the same birth year (a name alone is too
// common to trust); each contact in one group at most, strongest first
export const duplicateGroups = (rows: DupCandidate[]) => {
  const out: { reason: "nationalId" | "user" | "name"; key: string; ids: string[] }[] = [];
  const used = new Set<string>();
  const pass = (reason: "nationalId" | "user" | "name", keyOf: (r: DupCandidate) => string | null) => {
    const by = new Map<string, string[]>();
    for (const r of rows) {
      if (used.has(r.id)) continue;
      const k = keyOf(r);
      if (!k) continue;
      by.set(k, [...(by.get(k) || []), r.id]);
    }
    for (const [key, ids] of by)
      if (ids.length > 1) {
        out.push({ reason, key, ids });
        ids.forEach((id) => used.add(id));
      }
  };
  pass("nationalId", (r) => {
    const n = toLatin(r.nationalId || "").replace(/\D/g, "");
    return n.length === 10 ? n : null;
  });
  pass("user", (r) => r.user || null);
  pass("name", (r) => {
    const n = normName(r.name);
    return n.length >= 5 && r.birthYear ? `${n}|${r.birthYear}` : null;
  });
  return out;
};

// what the primary takes from the duplicates when merged: a blank filled
// from the first duplicate that has it, the tags joined, the counters
// summed, the first and last visit widened (Nexxa mergeContacts)
export type MergeFields = {
  name?: string;
  gender?: string;
  birthDate?: Date;
  birthYear?: number;
  birthMD?: number;
  city?: string;
  insurer?: string;
  note?: string;
  tags?: string[];
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  lastVisitAt?: Date;
  consentAt?: Date;
  smsOptOut?: boolean;
};
export const mergeFields = (primary: MergeFields, dups: MergeFields[]): MergeFields => {
  const out: MergeFields = { ...primary };
  const blanks: (keyof MergeFields)[] = ["name", "gender", "birthDate", "birthYear", "birthMD", "city", "insurer", "note"];
  for (const k of blanks)
    if (out[k] === undefined || out[k] === null || out[k] === "") {
      const from = dups.find((d) => d[k] !== undefined && d[k] !== null && d[k] !== "");
      if (from) (out as Record<string, unknown>)[k] = from[k];
    }
  out.tags = Array.from(new Set([...(primary.tags || []), ...dups.flatMap((d) => d.tags || [])])).slice(0, 50);
  const dates = (k: "firstSeenAt" | "lastSeenAt" | "lastVisitAt" | "consentAt") =>
    [primary, ...dups].map((d) => d[k]).filter((v): v is Date => !!v && !Number.isNaN(new Date(v).getTime())).map((v) => new Date(v).getTime());
  const first = dates("firstSeenAt");
  if (first.length) out.firstSeenAt = new Date(Math.min(...first));
  const consent = dates("consentAt");
  if (consent.length) out.consentAt = new Date(Math.min(...consent));
  const last = dates("lastSeenAt");
  if (last.length) out.lastSeenAt = new Date(Math.max(...last));
  const lv = dates("lastVisitAt");
  if (lv.length) out.lastVisitAt = new Date(Math.max(...lv));
  // one "no SMS" wins: the person asked for it under either record
  out.smsOptOut = !!primary.smsOptOut || dups.some((d) => !!d.smsOptOut);
  return out;
};

// ---------------------------------------------------------------- custom fields

export const cfTypes = ["text", "textarea", "number", "date", "select", "checkbox"] as const;

// a field key from its label, unique among the owner's keys
export const fieldKey = (label: string, taken: string[]) => {
  const base =
    toLatin(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 30) || "field";
  let key = base;
  for (let i = 2; taken.includes(key); i++) key = `${base}_${i}`;
  return key;
};

// the values to keep: the active fields from the form (an empty one is
// removed), the inactive ones' old values kept (Nexxa collectCustomFields)
export const collectCustomValues = (
  input: Record<string, unknown>,
  defs: { key: string; type: string }[],
  existing?: Record<string, unknown> | null,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing || {})) if (v !== undefined && v !== null && v !== "") out[k] = String(v);
  for (const d of defs) {
    if (!(d.key in input)) continue;
    const v = input[d.key];
    if (d.type === "checkbox") out[d.key] = v === true || v === "true" || v === "1" ? "1" : "0";
    else if (v !== undefined && v !== null && String(v).trim()) out[d.key] = String(v).trim().slice(0, 1000);
    else delete out[d.key];
  }
  return out;
};
