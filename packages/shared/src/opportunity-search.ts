import { OPERATION_LABELS, FUNNEL_STAGE_LABELS } from './constants.js';
import type { Opportunity, Operation } from './types/opportunity.js';
export type SearchableOpportunity = Partial<Opportunity> & { wa_contacts?: { name: string | null; phone: string } | null };
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function nationalPhone(value: string) {
 let digits = value.replace(/\D/g, '');
 if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2);
 if (digits.length === 11 && digits[2] === '9') digits = digits.slice(0, 2) + digits.slice(3);
 return digits;
}
export function matchesOpportunitySearch(row: SearchableOpportunity, query: string): boolean {
 const needle = normalize(query.trim());
 if (!needle) return true;
 const statuses: Record<string, string> = { open: 'Em andamento', won: 'Ganho Ganhos', lost: 'Perdido Perdidos' };
 const values = [row.wa_contacts?.name, row.wa_contacts?.phone, row.product_model, row.product, row.commercial_notes, row.next_action, row.main_objection, row.usage_purpose, row.urgency, row.lost_reason, row.operation && OPERATION_LABELS[row.operation as Operation], row.stage && FUNNEL_STAGE_LABELS[row.stage], row.status && statuses[row.status], row.sale_amount, row.credit_amount, row.down_payment_amount, row.target_installment_amount, row.term_months];
 if (values.some(value => value != null && normalize(String(value)).includes(needle))) return true;
 // Phone-only query: tolerate formatting, country code and historical missing ninth digit.
 if (/^[+\d\s().-]+$/.test(query.trim())) {
  const digits = query.replace(/\D/g, '');
  const phone = row.wa_contacts?.phone ?? '';
  return digits.length >= 3 && (phone.replace(/\D/g, '').includes(digits) || nationalPhone(phone).includes(nationalPhone(query)));
 }
 return false;
}
export function buildWhatsAppUrl(phone: string | null | undefined): string | null {
 const digits = phone?.replace(/\D/g, '');
 if (!digits) return null;
 const withCountryCode = digits.startsWith('55') && digits.length >= 12 ? digits : `55${digits}`;
 return `https://wa.me/${withCountryCode}`;
}
