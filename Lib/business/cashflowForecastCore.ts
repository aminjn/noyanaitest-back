// The pure cash-flow projection (2026-10), ported as-is from Nexxa
// (lib/cashflow-forecast-core.ts) so it stays testable without a database:
// an opening cash balance and dated flows (+ in, - out) carried forward
// period by period. Lib/business/financeAi.ts gathers the flows from the
// books; tests in Lib/business/__tests__/cashflowForecastCore.test.ts.

export type DatedFlow = { date: number; amount: number; label?: string; kind?: string };
// end is exclusive
export type Period = { label: string; start: number; end: number };
export type ForecastRow = {
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  // cash at the period's end
  balance: number;
  negative: boolean;
};

export function projectCashflow(opening: number, flows: DatedFlow[], periods: Period[]): ForecastRow[] {
  let balance = opening;
  return periods.map((p) => {
    let inflow = 0;
    let outflow = 0;
    for (const f of flows) {
      if (f.date >= p.start && f.date < p.end) {
        if (f.amount >= 0) inflow += f.amount;
        else outflow += -f.amount;
      }
    }
    const net = inflow - outflow;
    balance += net;
    return { label: p.label, inflow, outflow, net, balance, negative: balance < -0.5 };
  });
}

// N monthly periods from given starts (the boundaries come from outside so
// the core stays pure)
export function monthlyPeriods(starts: number[], labels: string[]): Period[] {
  const out: Period[] = [];
  for (let i = 0; i < starts.length; i++) {
    out.push({ label: labels[i] ?? `${i + 1}`, start: starts[i], end: starts[i + 1] ?? starts[i] + 30 * 86_400_000 });
  }
  return out;
}

// The lowest balance reached day by day and the day it happens (Noyan's
// addition: a month can end positive and still dip below zero mid-month).
export function lowestPoint(opening: number, flows: DatedFlow[], start: number, end: number): { balance: number; date: number } {
  const inRange = flows.filter((f) => f.date >= start && f.date < end).sort((a, b) => a.date - b.date);
  let balance = opening;
  let low = { balance: opening, date: start };
  for (const f of inRange) {
    balance += f.amount;
    if (balance < low.balance) low = { balance, date: f.date };
  }
  return low;
}
