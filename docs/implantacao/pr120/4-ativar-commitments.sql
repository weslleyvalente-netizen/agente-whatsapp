-- PR #120 — ativação de commitments_enabled (promessas de retorno + lembrete interno de proposta em 30 min)
-- Organização: Moto e Trilha (cf01d00d-77f9-42bf-afd7-f22819f201c8). Executar SOMENTE com autorização expressa do dono.
-- Antes: salvar o backup de settings (consulta 0 abaixo) em backup-org-settings-antes-commitments-<data>.json.
-- Efeito: na próxima rodada do worker (até 5 min) a rotina passa a ler as mensagens do vendedor das últimas 24 h.
-- Nada é enviado ao cliente: só cria linhas em seller_commitments/proposal_followups e tarefas internas.

-- 0) Backup (somente leitura): copiar o resultado inteiro para o arquivo de backup.
-- select settings from public.organizations where id = 'cf01d00d-77f9-42bf-afd7-f22819f201c8';

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Só liga se a chave ainda não existir (evita sobrescrever um estado que alguém já mexeu).
UPDATE public.organizations
   SET settings = jsonb_set(settings, '{commitments_enabled}', 'true'::jsonb, true)
 WHERE id = 'cf01d00d-77f9-42bf-afd7-f22819f201c8'
   AND NOT (settings ? 'commitments_enabled')
RETURNING id, settings->'commitments_enabled' AS commitments_enabled,
          settings ? 'escape_distribution_enabled' AS tem_escape,
          settings ? 'lid_auto_merge_enabled'      AS tem_lid,
          settings ? 'urgent_cards_enabled'        AS tem_urgent;
-- Esperado: 1 linha, commitments_enabled = true, tem_escape/tem_lid/tem_urgent = false.
-- Se vier 0 linhas: ROLLBACK e consultar o dono.

COMMIT;
