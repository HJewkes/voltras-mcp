// Calendar arithmetic on 'YYYY-MM-DD' strings, all read as UTC midnight so no zone can shift a day.

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday of the ISO week `date` falls in. */
export function isoWeekStart(date: string): string {
  const weekday = new Date(Date.parse(date)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** Every Monday from the week of `first` to the week of `last`, inclusive. */
export function weeksSpanning(first: string, last: string): string[] {
  const weeks: string[] = [];
  for (let week = isoWeekStart(first); week <= last; week = addDays(week, 7)) weeks.push(week);
  return weeks;
}

/** A noon-UTC instant for `date`, which reads as the same calendar date in any zone within 11 hours. */
export function noonInstant(date: string): string {
  return `${date}T12:00:00.000Z`;
}
