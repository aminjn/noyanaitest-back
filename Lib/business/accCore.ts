// The pure cores of Noyan accounting (2026-10), ported one-to-one from
// Nexxa (aminjn/nexxacrm src/lib: depreciation-core, bank-match-core,
// allocation-core, account-tree, tree-cycle-core, account-rollup-core,
// year-end, tax-report). No database and no session here, so each is tested
// directly (Scripts/accCore.test.ts, the port of Nexxa's vitest suites) and
// every Lib/business module that books on the one engine calls the same
// arithmetic.

// ------------------------------------------------------------ depreciation

export type DepAsset = {
  cost: number;
  salvageValue: number;
  usefulLifeYears: number;
  method: string;
  decliningRate: number;
  accumulatedDep: number;
};

// whole months elapsed between two dates (>= 0)
export function wholeMonths(from: Date, to: Date): number {
  const m = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  return Math.max(0, m);
}

// N months of depreciation from the asset's current state, never below its
// salvage value. straight: (cost - salvage) / (life x 12) a month;
// declining: the monthly rate on the current net book value.
export function depreciationForMonths(a: DepAsset, months: number): number {
  if (months <= 0) return 0;
  const floor = a.salvageValue;
  let nbv = a.cost - a.accumulatedDep;
  const maxRemaining = Math.max(0, nbv - floor);
  if (maxRemaining <= 0.5) return 0;
  if (a.method === "declining" && a.decliningRate > 0) {
    const monthlyRate = a.decliningRate / 100 / 12;
    let dep = 0;
    for (let i = 0; i < months; i++) {
      const step = Math.min(nbv * monthlyRate, nbv - floor);
      if (step <= 0.5) break;
      dep += step;
      nbv -= step;
    }
    return Math.round(dep);
  }
  const monthly = (a.cost - a.salvageValue) / Math.max(1, a.usefulLifeYears * 12);
  return Math.round(Math.min(monthly * months, maxRemaining));
}

// Revaluation, proportional method (IAS 16): cost and accumulated
// depreciation are scaled by fair value / net book value so the book value
// becomes the fair value and the share already depreciated is kept. An
// increase goes to the revaluation surplus (equity); a decrease first
// reverses earlier surplus, the rest is an expense. The surplus is taken
// from the rounded deltas so the voucher always balances.
export function computeRevaluation(cur: { cost: number; accumulatedDep: number }, fairValue: number, priorSurplus: number) {
  const oldNbv = cur.cost - cur.accumulatedDep;
  let newCost: number, newAccum: number;
  if (oldNbv > 0.5) {
    const ratio = fairValue / oldNbv;
    newCost = Math.round(cur.cost * ratio);
    newAccum = Math.round(cur.accumulatedDep * ratio);
  } else {
    newCost = Math.round(fairValue + cur.accumulatedDep);
    newAccum = Math.round(cur.accumulatedDep);
  }
  const costDelta = newCost - cur.cost;
  const accumDelta = newAccum - cur.accumulatedDep;
  const surplus = costDelta - accumDelta;
  const prior = Math.max(0, priorSurplus);
  const equityUp = Math.max(0, surplus);
  const decrease = Math.max(0, -surplus);
  const equityDown = Math.min(prior, decrease);
  const expense = decrease - equityDown;
  const equityPortion = equityUp - equityDown;
  return { oldNbv, newCost, newAccum, costDelta, accumDelta, surplus, equityUp, equityDown, expense, equityPortion };
}

// Iranian tax depreciation presets (ماده‌ی ۱۴۹ ق.م.م، جدول استهلاکات
// ۱۳۹۵), the groups a medical practice owns. Shown as editable defaults of
// an asset group; the owner checks them against the current table.
export const IRAN_DEP_PRESETS = [
  { key: "medical", name: "تجهیزات پزشکی و آزمایشگاهی", usefulLifeYears: 10, method: "straight", decliningRate: 0, role: "equipment" },
  { key: "furniture", name: "اثاثیه و منصوبات", usefulLifeYears: 10, method: "straight", decliningRate: 0, role: "furniture" },
  { key: "computer", name: "رایانه و تجهیزات جانبی", usefulLifeYears: 3, method: "straight", decliningRate: 0, role: "furniture" },
  { key: "vehicle", name: "وسایط نقلیه (آمبولانس و خودرو)", usefulLifeYears: 6, method: "declining", decliningRate: 25, role: "equipment" },
  { key: "building", name: "ساختمان", usefulLifeYears: 25, method: "declining", decliningRate: 7, role: "equipment" },
] as const;

// ------------------------------------------------------ bank statements

export type BookLine = { id: string; date: number; amount: number }; // debit - credit
export type StmtLine = { date: number; amount: number; desc?: string };
export type MatchResult = {
  matches: { stmtIndex: number; bookId: string; dayDiff: number }[];
  unmatchedStmt: number[];
  unmatchedBook: string[];
};

// One-to-one greedy matching of statement rows to book rows: the same
// signed amount (deposit +, withdrawal -) and the closest date within the
// window; statement rows in date order so the result is deterministic.
export function matchStatement(book: BookLine[], stmt: StmtLine[], maxDays = 5): MatchResult {
  const usedBook = new Set<string>();
  const matches: MatchResult["matches"] = [];
  const unmatchedStmt: number[] = [];
  const order = stmt.map((_, i) => i).sort((a, b) => stmt[a].date - stmt[b].date || a - b);
  for (const si of order) {
    const s = stmt[si];
    let bestId: string | null = null;
    let bestDiff = Infinity;
    for (const b of book) {
      if (usedBook.has(b.id)) continue;
      if (Math.round(b.amount) !== Math.round(s.amount)) continue;
      const diff = Math.abs(b.date - s.date) / 86_400_000;
      if (diff <= maxDays && diff < bestDiff) {
        bestDiff = diff;
        bestId = b.id;
      }
    }
    if (bestId) {
      usedBook.add(bestId);
      matches.push({ stmtIndex: si, bookId: bestId, dayDiff: Math.round(bestDiff) });
    } else unmatchedStmt.push(si);
  }
  const unmatchedBook = book.filter((b) => !usedBook.has(b.id)).map((b) => b.id);
  return { matches, unmatchedStmt, unmatchedBook };
}

// --------------------------------------------------------- allocation

// Splits an amount by percentages with no rounding loss: the parts always
// add up to round(amount) (cumulative method). Cost allocation (تسهیم).
export function distribute(amount: number, percents: number[]): number[] {
  const total = percents.reduce((s, p) => s + p, 0);
  if (total <= 0 || amount === 0) return percents.map(() => 0);
  const out: number[] = [];
  let allocated = 0;
  let cum = 0;
  for (let i = 0; i < percents.length; i++) {
    cum += percents[i];
    const target = Math.round((amount * cum) / total);
    out.push(target - allocated);
    allocated = target;
  }
  return out;
}

// ------------------------------------------------------------- trees

// Walks a node's ancestors safely: a parent chain that loops back stops
// instead of spinning forever.
export function forEachAncestor<T extends { id: string; parentId: string | null }>(node: T, byId: Map<string, T>, visit: (ancestor: T) => void): void {
  const seen = new Set<string>([node.id]);
  let pid = node.parentId;
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const p = byId.get(pid);
    if (!p) break;
    visit(p);
    pid = p.parentId;
  }
}

export type ParentMap = Map<string, string | null>;

// Would making newParentId the parent of nodeId close a loop?
export function createsCycle(parents: ParentMap, nodeId: string, newParentId: string | null): boolean {
  if (!newParentId) return false;
  if (newParentId === nodeId) return true;
  const seen = new Set<string>([newParentId]);
  let cur = parents.get(newParentId) ?? null;
  while (cur) {
    if (cur === nodeId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = parents.get(cur) ?? null;
  }
  return false;
}

export type TreeNode = { id: string; parentId: string | null };
export type Turnover = { accountId: string; debit: number; credit: number };

// the root and every descendant of it
export function subtreeAccountIds<T extends TreeNode>(rootId: string, accounts: T[]): Set<string> {
  const ids = new Set<string>();
  const byId = new Map(accounts.map((a) => [a.id, a] as const));
  if (!byId.has(rootId)) return ids;
  ids.add(rootId);
  for (const a of accounts) {
    if (a.id === rootId) continue;
    let hit = false;
    forEachAncestor(a, byId, (p) => {
      if (p.id === rootId) hit = true;
    });
    if (hit) ids.add(a.id);
  }
  return ids;
}

export function rollupTurnover<T extends TreeNode>(rootId: string, accounts: T[], lines: Turnover[]) {
  const ids = subtreeAccountIds(rootId, accounts);
  let debit = 0;
  let credit = 0;
  if (ids.size === 0) return { debit, credit };
  for (const l of lines) {
    if (!ids.has(l.accountId)) continue;
    debit += l.debit;
    credit += l.credit;
  }
  return { debit, credit };
}

// ----------------------------------------------------------- year end

export type LedgerLine = { accountId: string; tafsiliId: string | null; costCenterId: string | null; debit: number; credit: number };
export type CloseLine = { accountId: string; tafsiliId?: string | null; costCenterId?: string | null; label: string; debit: number; credit: number };

// The permanent close: each (account x tafsili x cost centre) balance is
// brought to zero, so a patient's or vendor's balance is carried across
// the year, not lost into one account total.
export function groupPermanentClosing(lines: LedgerLine[], nameOf: (accountId: string) => string, tol = 0.5): CloseLine[] {
  const groups = new Map<string, LedgerLine & { net: number }>();
  for (const l of lines) {
    const key = `${l.accountId}|${l.tafsiliId ?? ""}|${l.costCenterId ?? ""}`;
    const g = groups.get(key) ?? { accountId: l.accountId, tafsiliId: l.tafsiliId, costCenterId: l.costCenterId, debit: 0, credit: 0, net: 0 };
    g.net += l.debit - l.credit;
    groups.set(key, g);
  }
  const out: CloseLine[] = [];
  for (const g of groups.values()) {
    if (Math.abs(g.net) < tol) continue;
    const label = `بستن دائم ${nameOf(g.accountId)}`;
    out.push(
      g.net > 0
        ? { accountId: g.accountId, tafsiliId: g.tafsiliId, costCenterId: g.costCenterId, label, debit: 0, credit: Math.round(g.net * 100) / 100 }
        : { accountId: g.accountId, tafsiliId: g.tafsiliId, costCenterId: g.costCenterId, label, debit: Math.round(-g.net * 100) / 100, credit: 0 },
    );
  }
  return out;
}

// the opening voucher is the permanent close reversed, dimensions kept
export function reverseClosingToOpening(closingLines: CloseLine[], tol = 0.5): CloseLine[] {
  return closingLines
    .filter((l) => l.debit > tol || l.credit > tol)
    .map((l) => ({
      accountId: l.accountId,
      tafsiliId: l.tafsiliId ?? null,
      costCenterId: l.costCenterId ?? null,
      label: (l.label ?? "").replace(/^بستن دائم /, "افتتاحیه ") || "افتتاحیه",
      debit: l.credit,
      credit: l.debit,
    }));
}

export function totals(lines: { debit: number; credit: number }[]) {
  return lines.reduce((s, l) => ({ debit: s.debit + l.debit, credit: s.credit + l.credit }), { debit: 0, credit: 0 });
}

// ---------------------------------------------------- trial balance

export type TrialAgg = { code: string; name: string; openD: number; openC: number; turnD: number; turnC: number };

// one row of a 2/4/6/8-column trial balance: opening and closing are nets
// on one side, turnover and cumulative turnover are gross
export function trialRow(r: TrialAgg) {
  const openNet = r.openD - r.openC;
  const closeNet = openNet + r.turnD - r.turnC;
  return {
    code: r.code,
    name: r.name,
    openDebit: openNet > 0 ? openNet : 0,
    openCredit: openNet < 0 ? -openNet : 0,
    turnDebit: r.turnD,
    turnCredit: r.turnC,
    cumDebit: r.openD + r.turnD,
    cumCredit: r.openC + r.turnC,
    closeDebit: closeNet > 0 ? closeNet : 0,
    closeCredit: closeNet < 0 ? -closeNet : 0,
  };
}

// --------------------------------------------- seasonal (ماده‌ی ۱۶۹)

export type TaxParty = { name: string; nationalId?: string | null; economicCode?: string | null };
export type TaxDoc = { net: number; vat: number; party: TaxParty };
export type PartyRow = { key: string; name: string; nationalId: string; economicCode: string; count: number; amount: number; vat: number };

// a party is grouped by its national id, then economic code, then name:
// the system works on ids and two parties with one name must not merge
export function partyKey(p: TaxParty): string {
  const nid = (p.nationalId ?? "").trim();
  if (nid) return `nid:${nid}`;
  const ec = (p.economicCode ?? "").trim();
  if (ec) return `ec:${ec}`;
  return `nm:${(p.name ?? "").trim()}`;
}

export function partyHasTaxIdentity(p: TaxParty): boolean {
  return Boolean((p.nationalId ?? "").trim() || (p.economicCode ?? "").trim());
}

export function groupByParty(docs: TaxDoc[]): PartyRow[] {
  const map = new Map<string, PartyRow>();
  for (const d of docs) {
    const key = partyKey(d.party);
    const cur = map.get(key) ?? {
      key,
      name: d.party.name ?? "",
      nationalId: (d.party.nationalId ?? "").trim(),
      economicCode: (d.party.economicCode ?? "").trim(),
      count: 0,
      amount: 0,
      vat: 0,
    };
    cur.count += 1;
    cur.amount += d.net;
    cur.vat += d.vat;
    if (!cur.nationalId && (d.party.nationalId ?? "").trim()) cur.nationalId = (d.party.nationalId ?? "").trim();
    if (!cur.economicCode && (d.party.economicCode ?? "").trim()) cur.economicCode = (d.party.economicCode ?? "").trim();
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

export function computeVatReturn(sales: TaxDoc[], purchases: TaxDoc[]) {
  const taxableSales = sales.reduce((s, d) => s + d.net, 0);
  const outputVat = sales.reduce((s, d) => s + d.vat, 0);
  const taxablePurchases = purchases.reduce((s, d) => s + d.net, 0);
  const inputVat = purchases.reduce((s, d) => s + d.vat, 0);
  const net = outputVat - inputVat;
  return { taxableSales, outputVat, taxablePurchases, inputVat, vatPayable: Math.max(0, net), creditCarryforward: Math.max(0, -net) };
}

// ------------------------------------------------------ coding import

// Parses "code name" lines (a chart exported from Sepidar / Hamkaran / a
// spreadsheet): the level follows the code's length (1 group, 2 total, 4+
// detail), the parent is the longest existing prefix, the type follows the
// first digit of the Iranian standard coding.
export type CodingRow = { code: string; name: string; level: "group" | "total" | "detail"; parent?: string; type: "asset" | "liability" | "equity" | "income" | "expense" };

export const typeOfCode = (code: string): CodingRow["type"] =>
  ({ "1": "asset", "2": "asset", "3": "liability", "4": "liability", "5": "equity", "6": "income", "7": "expense", "8": "expense", "9": "expense" } as const)[code[0] as "1"] || "expense";

export function parseCoding(text: string): CodingRow[] {
  const toLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const rows: CodingRow[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = toLatin(raw).trim();
    const m = line.match(/^(\d{1,12})[\s,;\t\-–—:|]+(.+)$/);
    if (!m) continue;
    const code = m[1];
    const name = m[2].replace(/^["']|["']$/g, "").trim().slice(0, 200);
    if (!name || seen.has(code)) continue;
    seen.add(code);
    const level = code.length === 1 ? "group" : code.length <= 3 ? "total" : "detail";
    rows.push({ code, name, level, type: typeOfCode(code) });
  }
  // parent: the longest shorter code that is a prefix of this one
  const codes = rows.map((r) => r.code);
  for (const r of rows) {
    let best = "";
    for (const c of codes) if (c.length < r.code.length && r.code.startsWith(c) && c.length > best.length) best = c;
    if (best) r.parent = best;
  }
  return rows;
}

// --------------------------------------------- treasury negative policy

export type NegativePolicy = "allow" | "warn" | "block";

// what a credit to a till or bank would leave: allow posts, block refuses
// a voucher that takes the balance below zero, warn posts and warns
export function negativeCheck(policy: NegativePolicy, balance: number, credit: number): "ok" | "warn" | "block" {
  if (policy === "allow" || balance - credit >= -0.5) return "ok";
  return policy === "block" ? "block" : "warn";
}
