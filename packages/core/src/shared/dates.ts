/**
 * Dates.
 *
 * A membership runs on business days, not instants. "Expires 30 November"
 * means the member may train on 30 November — so an end date is INCLUSIVE,
 * and every calculation here keeps it that way.
 *
 * Everything is computed in UTC against date-only values. The gym's timezone
 * matters for *when* a day starts, which is handled where the day boundary is
 * decided, not here.
 */

export type DurationUnit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' | 'SESSION';

export const MS_PER_DAY = 86_400_000;

/** Midnight UTC on the same calendar day. */
export function startOfDay(value: Date | string): Date {
  const date = typeof value === 'string' ? new Date(`${value}T00:00:00.000Z`) : value;
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

export function addDays(date: Date, days: number): Date {
  return new Date(startOfDay(date).getTime() + days * MS_PER_DAY);
}

/**
 * Adds months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March. Rolling over would
 * quietly give a member two extra days every time their plan renews from a
 * long month, and the error compounds.
 */
export function addMonths(date: Date, months: number): Date {
  const base = startOfDay(date);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();

  const targetMonth = month + months;
  const lastDayOfTarget = new Date(
    Date.UTC(year, targetMonth + 1, 0),
  ).getUTCDate();

  return new Date(Date.UTC(year, targetMonth, Math.min(day, lastDayOfTarget)));
}

/**
 * The inclusive end date for a membership starting on `start`.
 *
 * A one-month plan from 1 November ends on 30 November — the member trains
 * on both days. Off-by-one here is a day of revenue or a day of goodwill,
 * every single membership.
 */
export function endDateFor(start: Date, unit: DurationUnit, value: number): Date {
  const from = startOfDay(start);

  switch (unit) {
    case 'DAY':
      return addDays(from, value - 1);
    case 'WEEK':
      return addDays(from, value * 7 - 1);
    case 'MONTH':
      return addDays(addMonths(from, value), -1);
    case 'YEAR':
      return addDays(addMonths(from, value * 12), -1);
    case 'SESSION':
      // Session packages are consumed, not timed. A generous outer window
      // stops them living forever; the real limit is sessionsTotal.
      return addDays(addMonths(from, 12), -1);
  }
}

/** Inclusive day count: 1 November to 30 November is 30 days, not 29. */
export function inclusiveDays(start: Date, end: Date): number {
  return Math.round((startOfDay(end).getTime() - startOfDay(start).getTime()) / MS_PER_DAY) + 1;
}

export function isOnOrBefore(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() <= startOfDay(b).getTime();
}

export function isOnOrAfter(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() >= startOfDay(b).getTime();
}

export function today(): Date {
  return startOfDay(new Date());
}

/** Indian financial year: April to March, written 2026-27. */
export function financialYear(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() + 1 >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** For display in the gym's own timezone rather than the server's. */
export function formatDate(date: Date, timezone = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  }).format(date);
}

/** The gym's current business day, which on Hostinger's UTC clock is not today. */
export function businessDay(timezone = 'Asia/Kolkata', at: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(at);
  return startOfDay(parts);
}

/**
 * The real instants a gym's business day begins and ends.
 *
 * `businessDay` answers "what date is it at the gym" as a date-only value.
 * This answers "which moments count as that date" — which is what a query
 * over a timestamp column needs.
 *
 * The two are not interchangeable, and conflating them is a live bug: a UTC
 * day boundary puts an Indian gym's "today" from 05:30 to 05:30, so the
 * takings counted at the end of a late shift belong to the wrong day and the
 * date printed on the report is yesterday's.
 */
export function businessDayRange(
  timezone = 'Asia/Kolkata',
  at: Date = new Date(),
): { start: Date; end: Date; date: Date } {
  const date = businessDay(timezone, at);

  // The offset the zone is at on that date, worked out by asking what that
  // wall-clock moment is in UTC. Doing it per date rather than with a fixed
  // number keeps it right across a daylight-saving change in zones that have
  // one; India does not, but a gym abroad on this platform might.
  const asUtc = new Date(date.getTime());
  const offsetMinutes = zoneOffsetMinutes(timezone, asUtc);

  const start = new Date(date.getTime() - offsetMinutes * 60_000);
  return { start, end: new Date(start.getTime() + MS_PER_DAY), date };
}

/** Minutes the zone is ahead of UTC at that instant. */
function zoneOffsetMinutes(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );

  return Math.round((asIfUtc - at.getTime()) / 60_000);
}

/**
 * The gym's current business day as `YYYY-MM-DD`.
 *
 * What every caller that needs to pass a date to a service should use.
 * `new Date().toISOString().slice(0, 10)` looks equivalent and is not: it is
 * the server's UTC date, which for the five and a half hours after midnight
 * in India is yesterday — long enough to drop the whole early-morning rush
 * out of a report.
 */
export function businessDayIso(timezone = 'Asia/Kolkata', at: Date = new Date()): string {
  return businessDay(timezone, at).toISOString().slice(0, 10);
}
