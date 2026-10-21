import { describe, it, expect } from 'vitest';
import { requeryDate, canRequery, CredProMockAdapter } from './policy.js';
const calendar = { years: [2026, 2027], holidays: ['2026-10-30'] };
describe('single financing requery', () => {
  it('uses holidays and moves first consultation on last business day to next month', () => {
    expect(requeryDate('2026-10-20', calendar)).toBe('2026-10-29');
    expect(requeryDate('2026-10-29', calendar)).toBe('2026-11-30');
    expect(requeryDate('2026-10-31', calendar)).toBe('2026-11-30');
  });
  it('fails closed without calendar coverage', () => expect(() => requeryDate('2028-01-10', calendar)).toThrow());
  it('does not treat errors, simulation or missing results as unanimous refusal', () => {
    const base = { attempt: 0, statuses: ['rejected', 'rejected'], consentValid: true, providerAllows: true, interested: true, open: true };
    expect(canRequery(base)).toBe(true);
    for (const statuses of [[], ['rejected', 'error'], ['rejected', 'simulation'], ['preapproved'], ['pending']]) expect(canRequery({ ...base, statuses })).toBe(false);
    for (const patch of [{ attempt: 1 }, { consentValid: false }, { providerAllows: false }, { interested: false }, { open: false }]) expect(canRequery({ ...base, ...patch })).toBe(false);
  });
  it('mock contains no network and only returns explicitly configured fictitious terms', async () => {
    const adapter = new CredProMockAdapter();
    expect(await adapter.submit('mock-approved')).toMatchObject({ status: 'preapproved', offers: [{ downPayment: 5000, installments: 36 }, { downPayment: 5000, installments: 48 }] });
    expect(await adapter.submit('mock-rejected')).toEqual({ status: 'rejected', offers: [] });
    await expect(adapter.submit('PAN')).rejects.toThrow();
  });
});
