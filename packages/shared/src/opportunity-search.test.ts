import { describe, expect, it } from 'vitest';
import type { SearchableOpportunity } from './opportunity-search.js';
import { matchesOpportunitySearch, buildWhatsAppUrl } from './opportunity-search.js';
const row: SearchableOpportunity = { wa_contacts: { name: 'Sônia Ávila', phone: '556296366089' }, operation: 'consortium', stage: 'formalization', status: 'won', product_model: 'Factor 150', commercial_notes: 'Veio da bike, aderiu ao consórcio', credit_amount: 22000 };
describe('opportunity search', () => {
 it('matches names without accents or case', () => expect(matchesOpportunitySearch(row,'sonia avila')).toBe(true));
 it('matches formatted phone numbers', () => expect(matchesOpportunitySearch(row,'(62) 9636-6089')).toBe(true));
 it('matches current Brazilian ninth digit against older stored phone', () => expect(matchesOpportunitySearch(row,'(62) 99636-6089')).toBe(true));
 it('matches product and commercial notes', () => { expect(matchesOpportunitySearch(row,'factor')).toBe(true); expect(matchesOpportunitySearch(row,'bike')).toBe(true); });
 it('matches operation and status labels', () => { expect(matchesOpportunitySearch(row,'consorcio')).toBe(true); expect(matchesOpportunitySearch(row,'ganho')).toBe(true); });
 it('does not match an unrelated phone by amount', () => expect(matchesOpportunitySearch(row,'99999999')).toBe(false));
 it('keeps all rows when query is blank', () => expect(matchesOpportunitySearch(row,' ')).toBe(true));
});
describe('WhatsApp link', () => {
 it('adds country code and removes formatting', () => expect(buildWhatsAppUrl('(62) 99636-6089')).toBe('https://wa.me/5562996366089'));
 it('preserves existing country code', () => expect(buildWhatsAppUrl('+55 62 99636-6089')).toBe('https://wa.me/5562996366089'));
 it('does not produce a link without a phone', () => expect(buildWhatsAppUrl(null)).toBe(null));
});
