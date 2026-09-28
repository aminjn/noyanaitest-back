import Order from "../Models/Order";

const TIMEZONE = "Asia/Tehran";
const DAY = 24 * 60 * 60 * 1000;

type Line = { item?: unknown; price?: number; qty?: number };

const dayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Daily paid-order count and own-line revenue for one seller (pharmacy /
// paraClinic) over the last `days` Tehran days, oldest first - the trend
// chart on the provider dashboard home. `match` finds the seller's orders,
// `ownLines` picks the seller's own lines out of one order (orders can mix
// several sellers' items; only this seller's share counts as its revenue).
export const dailyOrderStats = async (
  match: Record<string, unknown>,
  ownLines: (order: any) => Line[],
  days = 30,
) => {
  const since = new Date(Date.now() - days * DAY);
  const orders = await Order.find({
    ...match,
    status: "paid",
    submittedAt: { $gte: since },
  })
    .select("submittedAt products productPackages tests")
    .lean();

  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--)
    keys.push(dayKey.format(new Date(Date.now() - i * DAY)));
  const byDay = new Map(keys.map((date) => [date, { orders: 0, revenue: 0 }]));

  for (const order of orders as any[]) {
    if (!order.submittedAt) continue;
    const bucket = byDay.get(dayKey.format(new Date(order.submittedAt)));
    if (!bucket) continue;
    bucket.orders += 1;
    bucket.revenue += ownLines(order).reduce(
      (sum, line) => sum + (line.price || 0) * (line.qty || 0),
      0,
    );
  }

  const series = keys.map((date) => ({
    date,
    orders: byDay.get(date)?.orders || 0,
    revenue: byDay.get(date)?.revenue || 0,
  }));
  return {
    days,
    series,
    totals: {
      orders: series.reduce((sum, p) => sum + p.orders, 0),
      revenue: series.reduce((sum, p) => sum + p.revenue, 0),
    },
  };
};
