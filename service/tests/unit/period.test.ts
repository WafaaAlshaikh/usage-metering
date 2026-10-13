import { describe, expect, it } from 'vitest';
import { parsePeriod, periodLabel, periodStartOf } from '../../src/domain/period';

describe('periodStartOf (UTC calendar month)', () => {
  it('returns the first day of the month', () => {
    expect(periodStartOf(new Date('2026-10-14T12:00:00Z'))).toBe('2026-10-01');
  });

  it('last millisecond of a month still belongs to that month', () => {
    expect(periodStartOf(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10-01');
  });

  it('first millisecond of the next month starts a new period', () => {
    expect(periodStartOf(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01');
  });

  it('uses UTC, not local time', () => {
    // 21:30 UTC on Oct 31 is already 00:30 on Nov 1 in Jerusalem (UTC+3).
    // The period must still be October.
    expect(periodStartOf(new Date('2026-10-31T21:30:00Z'))).toBe('2026-10-01');
  });

  it('handles the year boundary', () => {
    expect(periodStartOf(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-01');
    expect(periodStartOf(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
  });

  it('rejects an invalid date', () => {
    expect(() => periodStartOf(new Date('nope'))).toThrow(RangeError);
  });
});

describe('periodLabel / parsePeriod', () => {
  it('converts between database and API formats', () => {
    expect(periodLabel('2026-10-01')).toBe('2026-10');
    expect(parsePeriod('2026-10')).toBe('2026-10-01');
  });

  it.each(['2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', '', 'abc'])(
    'rejects malformed input %j',
    (input) => {
      expect(parsePeriod(input)).toBeNull();
    },
  );
});