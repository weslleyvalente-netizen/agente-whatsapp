-- Hotfix 27/11 (aplicado em produção às 12:39 com autorização do dono): a FK lead_assignments.responsible_rep_id → sales_reps
-- (migração 20261127140000) deixou ambíguas as consultas do PostgREST que embutem sales_reps a partir de lead_assignments
-- ("more than one relationship was found"), derrubando os avisos push de lead novo/SLA/cobrança/exceção. A coluna continua; só a FK sai.
-- As consultas passam a indicar a relação explicitamente (sales_reps!lead_assignments_rep_id_fkey), então a FK pode voltar no futuro.
-- Reverter: ALTER TABLE public.lead_assignments ADD CONSTRAINT lead_assignments_responsible_rep_id_fkey
--   FOREIGN KEY (responsible_rep_id) REFERENCES public.sales_reps(id) ON DELETE SET NULL;
ALTER TABLE public.lead_assignments DROP CONSTRAINT IF EXISTS lead_assignments_responsible_rep_id_fkey;
