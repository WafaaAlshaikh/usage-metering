import { describe, expect, it } from 'vitest';
import { evaluate, remainingAllowance, type ScopeState } from '../../src/domain/rules';

const state = (monthly: number | null, perRequest: number | null, consumed = 0): ScopeState => ({
  limits: { monthlyAllowance: monthly, maxUnitsPerRequest: perRequest },
  consumed,
});

// The example from the brief: account 10,000/month and 100/request,
// user 1,000/month and 20/request.
const account = (consumed = 0) => state(10_000, 100, consumed);
const user = (consumed = 0) => state(1_000, 20, consumed);

describe('evaluate: the examples from the brief', () => {
  it('rejects 25 units by the USER per-request limit even though both allowances have room', () => {
    const d = evaluate({ units: 25, account: account(), user: user() });
    expect(d.accepted).toBe(false);
    expect(d.rejection).toEqual({ scope: 'user', rule: 'max_per_request' });
  });

  it('accepts 10 units when both have enough remaining', () => {
    const d = evaluate({ units: 10, account: account(), user: user() });
    expect(d.accepted).toBe(true);
    expect(d.rejection).toBeNull();
    expect(d.accountRemainingAfter).toBe(9_990);
    expect(d.userRemainingAfter).toBe(990);
  });

  it('rejects 10 units when the ACCOUNT has only 5 left, even if the user has plenty', () => {
    const d = evaluate({ units: 10, account: account(9_995), user: user() });
    expect(d.accepted).toBe(false);
    expect(d.rejection).toEqual({ scope: 'account', rule: 'monthly_allowance' });
  });
});

describe('evaluate: a rejection consumes nothing', () => {
  it('leaves remaining allowances unchanged', () => {
    const d = evaluate({ units: 10, account: account(9_995), user: user(100) });
    expect(d.accountRemainingAfter).toBe(5);
    expect(d.userRemainingAfter).toBe(900);
  });
});

describe('evaluate: boundaries', () => {
  it('accepts exactly the remaining amount', () => {
    const d = evaluate({ units: 10, account: account(9_990), user: user() });
    expect(d.accepted).toBe(true);
    expect(d.accountRemainingAfter).toBe(0);
  });

  it('rejects one unit more than the remaining amount', () => {
    const d = evaluate({ units: 10, account: account(9_991), user: user() });
    expect(d.rejection).toEqual({ scope: 'account', rule: 'monthly_allowance' });
  });

  it('accepts exactly the per-request maximum', () => {
    const d = evaluate({ units: 20, account: account(), user: user() });
    expect(d.accepted).toBe(true);
  });
});

describe('evaluate: allowance reduced below existing usage', () => {
  it('shows 0 remaining and rejects further consumption at that level', () => {
    // The user already consumed 150, then their plan was changed to 100/month.
    const reduced = state(100, 20, 150);
    expect(remainingAllowance(reduced.limits, reduced.consumed)).toBe(0);

    const d = evaluate({ units: 1, account: account(), user: reduced });
    expect(d.rejection).toEqual({ scope: 'user', rule: 'monthly_allowance' });
    expect(d.userRemainingAfter).toBe(0);
  });
});

describe('evaluate: null limits mean unlimited', () => {
  it('accepts any amount and reports null remaining', () => {
    const d = evaluate({ units: 1_000_000, account: state(null, null, 5), user: state(null, null, 5) });
    expect(d.accepted).toBe(true);
    expect(d.accountRemainingAfter).toBeNull();
    expect(d.userRemainingAfter).toBeNull();
  });

  it('still enforces the other rule of the same plan', () => {
    const d = evaluate({ units: 50, account: state(null, 40), user: user() });
    // user per-request (20) is checked first
    expect(d.rejection).toEqual({ scope: 'user', rule: 'max_per_request' });
    const d2 = evaluate({ units: 50, account: state(null, 40), user: state(null, null) });
    expect(d2.rejection).toEqual({ scope: 'account', rule: 'max_per_request' });
  });
});

describe('evaluate: which rule is reported when several fail', () => {
  it('per-request beats monthly allowance', () => {
    // 25 units: over the user's per-request (20) AND over the user's remaining (10).
    const d = evaluate({ units: 25, account: account(), user: user(990) });
    expect(d.rejection).toEqual({ scope: 'user', rule: 'max_per_request' });
  });

  it('user is reported before account within the same tier', () => {
    const perRequest = evaluate({ units: 500, account: account(), user: user() });
    expect(perRequest.rejection?.scope).toBe('user');

    const monthly = evaluate({ units: 10, account: account(9_995), user: user(995) });
    expect(monthly.rejection).toEqual({ scope: 'user', rule: 'monthly_allowance' });
  });
});

describe('evaluate: input validation', () => {
  it.each([0, -1, 1.5, Number.NaN, Infinity])('throws for units = %s', (units) => {
    expect(() => evaluate({ units, account: account(), user: user() })).toThrow(RangeError);
  });
});