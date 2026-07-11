export const dateStartOfDay = (t: Date) => {
  const then = new Date(t);
  then.setHours(0, 0, 0, 0);
  return then;
};

export const todayStart = () => dateStartOfDay(new Date());

export const saturdayBasedDay = (day: number) => (day + 1) % 7;

export function getDaysInRange(start: Date, end: Date): number[] {
  const diffDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  if (diffDays >= 7) {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  const days = new Set<number>();
  for (let i = 0; i < diffDays; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.add((d.getDay() + 1) % 7);
  }
  return [...days];
}
