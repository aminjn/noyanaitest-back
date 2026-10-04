// Pure anomaly detection over voucher lines (2026-10), ported as-is from
// Nexxa (lib/anomaly-core.ts): fixed rules, no machine learning - an
// outlier amount for its account type (median and MAD, robust to skew), a
// probable duplicate, a large entry on a Friday (the Iranian weekend) and a
// large expense without a cost centre. Each anomaly has a severity and a
// reason; the reason is a content key with its values, so the page shows
// it in the reader's language. Tests in __tests__/anomalyCore.test.ts.

export type Txn = {
  id: string;
  // the line's absolute amount (debit or credit)
  amount: number;
  accountCode: string;
  // asset | liability | equity | income | expense
  accountType: string;
  date: number;
  // Friday, the weekend
  isFriday: boolean;
  hasCostCenter: boolean;
  label: string;
};

export type AnomalyReason = "faiAnOutlier" | "faiAnDuplicate" | "faiAnFriday" | "faiAnNoCenter";

export type Anomaly = {
  id: string;
  severity: "high" | "medium" | "low";
  reason: AnomalyReason;
  // values for the reason's text (the outlier's score)
  vars: string[];
  amount: number;
};

// the outlier threshold, in robust standard deviations
const MAD_K = 3;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// the anomalies of a list of lines, by severity then amount
export function detectAnomalies(txns: Txn[]): Anomaly[] {
  const out: Anomaly[] = [];

  // 1) an outlier amount per account type (median and MAD)
  const byType = new Map<string, Txn[]>();
  for (const t of txns) {
    const arr = byType.get(t.accountType) ?? [];
    arr.push(t);
    byType.set(t.accountType, arr);
  }
  for (const [, arr] of byType) {
    // too few lines: the statistics mean nothing
    if (arr.length < 5) continue;
    const amounts = arr.map((t) => t.amount);
    const med = median(amounts);
    const mad = median(amounts.map((a) => Math.abs(a - med))) || 1;
    for (const t of arr) {
      const score = Math.abs(t.amount - med) / (1.4826 * mad);
      if (score >= MAD_K && t.amount > med) {
        out.push({ id: t.id, severity: score >= MAD_K * 2 ? "high" : "medium", reason: "faiAnOutlier", vars: [String(Math.round(score))], amount: t.amount });
      }
    }
  }

  // 2) a probable duplicate: the same account and amount within 3 days
  const seen = new Map<string, Txn>();
  for (const t of [...txns].sort((a, b) => a.date - b.date)) {
    const key = `${t.accountCode}|${Math.round(t.amount)}`;
    const prev = seen.get(key);
    if (prev && Math.abs(t.date - prev.date) <= 3 * 86_400_000 && !out.some((o) => o.id === t.id)) {
      out.push({ id: t.id, severity: "medium", reason: "faiAnDuplicate", vars: [], amount: t.amount });
    }
    seen.set(key, t);
  }

  // 3) a large amount on the weekend (Friday)
  const bigThreshold = median(txns.map((t) => t.amount)) * 5;
  for (const t of txns) {
    if (t.isFriday && t.amount >= bigThreshold && bigThreshold > 0 && !out.some((o) => o.id === t.id)) {
      out.push({ id: t.id, severity: "low", reason: "faiAnFriday", vars: [], amount: t.amount });
    }
  }

  // 4) a large expense without a cost centre
  for (const t of txns) {
    if (t.accountType === "expense" && !t.hasCostCenter && t.amount >= bigThreshold && bigThreshold > 0 && !out.some((o) => o.id === t.id)) {
      out.push({ id: t.id, severity: "low", reason: "faiAnNoCenter", vars: [], amount: t.amount });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.amount - a.amount);
}
