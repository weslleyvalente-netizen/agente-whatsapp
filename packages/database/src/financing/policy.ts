export interface BusinessCalendar { years: number[]; holidays: string[] }
export function saoPauloDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function lastBusinessDay(year: number, month: number, calendar: BusinessCalendar): string {
  if (!calendar.years.includes(year)) throw new Error('Business calendar unavailable');
  const day = new Date(Date.UTC(year, month + 1, 0));
  while ([0, 6].includes(day.getUTCDay()) || calendar.holidays.includes(day.toISOString().slice(0, 10))) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
export function requeryDate(first: string, calendar: BusinessCalendar): string {
  const date = new Date(`${first}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
  const y = date.getUTCFullYear(), m = date.getUTCMonth();
  const current = lastBusinessDay(y, m, calendar);
  return first < current ? current : lastBusinessDay(m === 11 ? y + 1 : y, (m + 1) % 12, calendar);
}
export function canRequery(p: { attempt: number; statuses: string[]; consentValid: boolean; providerAllows: boolean; interested: boolean; open: boolean }) {
  return p.attempt === 0 && p.statuses.length > 0 && p.statuses.every(s => s === 'rejected') && p.consentValid && p.providerAllows && p.interested && p.open;
}
export type BankStatus = 'preapproved' | 'rejected' | 'simulation' | 'error';
export interface BankResult { status: BankStatus; offers: { downPayment: number; installments: number; installmentAmount: number }[] }
export interface FinancingAdapter {
  readonly mode: 'mock' | 'sandbox';
  submit(bank: string, application: Record<string, unknown>, requestKey: string): Promise<BankResult>;
}
// Local fixture adapter only. Not a claim about CredPro's real bank coverage,
// underwriting or pricing. No fetch(), credentials or production mode exists.
export class CredProMockAdapter implements FinancingAdapter {
  readonly mode = 'mock' as const;
  async submit(bank: string, _application?: Record<string, unknown>, _requestKey?: string): Promise<BankResult> {
    if (bank === 'mock-approved') return { status: 'preapproved', offers: [
      { downPayment: 5000, installments: 36, installmentAmount: 700 },
      { downPayment: 5000, installments: 48, installmentAmount: 580 },
    ] };
    if (bank === 'mock-rejected') return { status: 'rejected', offers: [] };
    if (bank === 'mock-error') return { status: 'error', offers: [] };
    if (bank === 'mock-simulation') return { status: 'simulation', offers: [] };
    throw new Error('Unsupported mock bank');
  }
}
