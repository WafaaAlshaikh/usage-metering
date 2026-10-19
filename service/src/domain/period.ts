const PERIOD_INPUT = /^(\d{4})-(0[1-9]|1[0-2])$/;


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