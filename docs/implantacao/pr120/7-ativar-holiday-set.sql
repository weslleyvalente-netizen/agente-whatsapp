-- PR #120 — calendário de feriados posse_go (executar SOMENTE com autorização expressa do dono).
-- Efeito simulado em 22/11/2026: nenhuma data nova fechada até 26/03/2027 (25/12/2026 e 01/01/2027 já estão em closedDates).
-- Afeta, nos feriados: SLA/distribuição, IA fora do horário, cutucar cliente, varredura de leads, promessas e monitor.
-- Decisões da loja (não são feriado legal) entram em extra_holidays (fecha) ou open_days (reabre), ex.: 24/12, 31/12, Carnaval.
BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE public.organizations
   SET settings = jsonb_set(settings, '{business_calendar,holiday_set}', '"posse_go"'::jsonb, true)
 WHERE id = 'cf01d00d-77f9-42bf-afd7-f22819f201c8'
   AND settings ? 'business_calendar'
   AND NOT (settings->'business_calendar' ? 'holiday_set')
RETURNING id, settings->'business_calendar'->>'holiday_set' AS holiday_set;
-- Esperado: 1 linha, posse_go. Desligar: jsonb_set(settings, '{business_calendar}', (settings->'business_calendar') - 'holiday_set').
COMMIT;
