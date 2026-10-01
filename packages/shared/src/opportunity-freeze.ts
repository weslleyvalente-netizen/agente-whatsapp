/** Calendar dates are compared in the organization's business timezone. */
export function isOpportunityFrozen(value: { frozen_until?: string | null }, today: string): boolean {
 return !!value.frozen_until && value.frozen_until > today;
}
export function isValidFreezeDate(date: string, today: string): boolean {
 if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= today) return false;
 const parsed = new Date(`${date}T12:00:00Z`);
 return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === date;
}
