const PERIOD_INPUT = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * First day of the UTC calendar month that contains `at`, as 'YYYY-MM-01'.
 * This is the value stored in the `period_start` columns. It always uses UTC, never the
 * server's local time zone, so a request at 00:30 on Nov 1 in Jerusalem (21:30 UTC on Oct 31)
 * still counts toward October.
 */
export function periodStartOf(at: Date): string {
  if (Number.isNaN(at.getTime())) throw new RangeError('invalid date');
  const year = String(at.getUTCFullYear()).padStart(4, '0');
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

/** 'YYYY-MM-01' (database) -> 'YYYY-MM' (what the API shows). */
export function periodLabel(periodStart: string): string {
  return periodStart.slice(0, 7);
}

/** 'YYYY-MM' (API input) -> 'YYYY-MM-01', or null when the input is malformed. */
export function parsePeriod(input: string): string | null {
  return PERIOD_INPUT.test(input) ? `${input}-01` : null;
}