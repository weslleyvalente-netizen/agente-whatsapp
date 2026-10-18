-- supabase/migrations/20261019120000_manager_only_config_writes.sql
-- Vendedores (role = 'agent') deixam de poder ALTERAR a configuração do agente de IA e das instâncias de WhatsApp pelo
-- cliente do navegador. Leitura (SELECT) segue liberada a todos os membros da organização: a conversa/funil mostra o nome
-- do agente/instância. Só INSERT/UPDATE/DELETE passam a exigir owner/admin.
--
-- Tabelas afetadas (todas criadas com a política genérica "por organização" em 00008, 00015 ou 00017):
--   agents, evolution_instances, knowledge_documents, knowledge_chunks, knowledge_faqs   (00008)
--   agent_configs, agent_playground_sessions, agent_playground_messages, agent_versions  (00015; agent_versions só tem INSERT)
--   agent_trainer_sessions, agent_trainer_messages                                       (00017)
-- NÃO alteradas: conversations, messages, wa_contacts, conversation_notes, opportunities, tasks, call logs etc.
-- O backend (API/worker) usa service role e ignora RLS: não é afetado.
--
-- COMO REVERTER: para cada tabela T acima, recriar as políticas antigas (as de agent_versions: apenas _insert):
--   DROP POLICY IF EXISTS "T_insert" ON public.T; DROP POLICY IF EXISTS "T_update" ON public.T; DROP POLICY IF EXISTS "T_delete" ON public.T;
--   CREATE POLICY "T_insert" ON public.T FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
--   CREATE POLICY "T_update" ON public.T FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()));
--   CREATE POLICY "T_delete" ON public.T FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()));
-- (opcionalmente DROP FUNCTION public.is_org_manager(uuid)).
--
-- ANTES DE APLICAR em produção, confira políticas fora do padrão (esperado: só _select/_insert/_update/_delete; agent_versions só _select/_insert):
--   select tablename, policyname, cmd, permissive, qual, with_check from pg_policies
--    where schemaname='public' and tablename in ('agents','evolution_instances','knowledge_documents','knowledge_chunks','knowledge_faqs',
--      'agent_configs','agent_versions','agent_playground_sessions','agent_playground_messages','agent_trainer_sessions','agent_trainer_messages')
--    order by 1,2;
-- No fim, a migration FALHA (RAISE) se sobrar qualquer política de escrita fora das novas, em vez de deixar um buraco silencioso.

-- Verdadeiro quando o usuário logado é owner/admin da organização p_org. SECURITY DEFINER para não depender da RLS de organization_members.
CREATE OR REPLACE FUNCTION public.is_org_manager(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members m
     WHERE m.organization_id = p_org AND m.user_id = auth.uid() AND m.role IN ('owner','admin')
  )
$$;
GRANT EXECUTE ON FUNCTION public.is_org_manager(uuid) TO authenticated, service_role;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agents','evolution_instances','knowledge_documents','knowledge_chunks','knowledge_faqs',
    'agent_configs','agent_playground_sessions','agent_playground_messages',
    'agent_trainer_sessions','agent_trainer_messages'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_insert" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_update" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_delete" ON public.%1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON public.%1$s FOR INSERT WITH CHECK (public.is_org_manager(organization_id))', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON public.%1$s FOR UPDATE USING (public.is_org_manager(organization_id)) WITH CHECK (public.is_org_manager(organization_id))', t);
    EXECUTE format('CREATE POLICY "%1$s_delete" ON public.%1$s FOR DELETE USING (public.is_org_manager(organization_id))', t);
  END LOOP;

  -- agent_versions é append-only (sem UPDATE/DELETE): só a política de INSERT muda.
  DROP POLICY IF EXISTS "agent_versions_insert" ON public.agent_versions;
  CREATE POLICY "agent_versions_insert" ON public.agent_versions FOR INSERT WITH CHECK (public.is_org_manager(organization_id));

  -- Garantia: nenhuma política de escrita (INSERT/UPDATE/DELETE/ALL) fora das novas, que exigem is_org_manager, pode restar.
  PERFORM 1 FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename = ANY (ARRAY['agents','evolution_instances','knowledge_documents','knowledge_chunks','knowledge_faqs',
                                  'agent_configs','agent_versions','agent_playground_sessions','agent_playground_messages',
                                  'agent_trainer_sessions','agent_trainer_messages'])
     AND p.cmd IN ('INSERT','UPDATE','DELETE','ALL')
     AND NOT (p.policyname IN (p.tablename || '_insert', p.tablename || '_update', p.tablename || '_delete')
              AND COALESCE(p.qual, '') || COALESCE(p.with_check, '') LIKE '%is_org_manager%');
  IF FOUND THEN
    RAISE EXCEPTION 'manager_only_config_writes: restam políticas de escrita fora do padrão nas tabelas de configuração; remova-as e rode de novo (veja a consulta no cabeçalho)';
  END IF;
END $$;
