# PWA instalável + notificações push para vendedores

**Objetivo:** vendedor (ex.: Márcio) instala o CRM no celular como app (Android e iOS 16.4+) e recebe notificação push mesmo com o app fechado.

## Parte 1 — PWA (apps/web)
- `app/manifest.ts` (Next metadata route): name "Moto e Trilha — Atendimento", short_name "Moto e Trilha", start_url "/conversations" (ou a rota inicial atual do dashboard), display "standalone", background/theme color conforme tokens do tema, ícones 192, 512 e maskable 512 gerados a partir de `public/logo-moto-e-trilha.png` sobre fundo branco (arquivos estáticos em `public/icons/`; gere com sharp/ImageMagick se disponível, senão com um script Node usando sharp já presente no projeto Next).
- `appleWebApp` + `icons.apple` (180x180) no metadata do layout; manter `viewport` atual.
- Service worker `public/sw.js` (sem cache de páginas/API, para não servir dado velho): só trata `push` (mostra notificação com title/body/url/tag) e `notificationclick` (foca janela existente e navega para `data.url`, ou abre nova).
- Cabeçalhos: `/sw.js` com `Cache-Control: no-cache` e `Service-Worker-Allowed: /` em `next.config`.

## Parte 2 — Push
**Dados (migration nova `supabase/migrations/20261018120000_push_notifications.sql`, NÃO aplicar):**
- `push_subscriptions(id uuid pk, organization_id, user_id, endpoint text unique, p256dh text, auth text, user_agent text, created_at, last_seen_at)` com RLS: usuário só vê/gerencia as próprias; service role total.
- `push_notification_log(dedupe_key text primary key, user_id, created_at)` (idempotência; só service role).
- Flag `organizations.settings.push_notifications_enabled` (default ausente = desligado), tipada em `OrganizationSettings` no shared.

**API (apps/api):** `web-push` com `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (env). Sem as chaves, o recurso fica inerte (sem erro).
- `GET /push/public-key`, `POST /push/subscribe` (upsert por endpoint, usuário autenticado), `POST /push/unsubscribe`, `POST /push/test` (envia teste ao próprio usuário).
- Serviço `sendPushToUser(db, userId, payload)`: envia a todas as subscriptions; em 404/410 apaga a subscription; falha de um endpoint não impede os outros; nunca loga endpoint/chaves.

**Gatilhos (worker, varredura a cada 30 s, padrão de `lead-sla.ts`; idempotência via `push_notification_log.dedupe_key`):**
1. Lead novo atribuído ao vendedor (`lead_assignments` pendente com `assigned_to` = vendedor): "Novo lead: {nome}". Chave `assign:{assignment_id}`.
2. Mensagem de cliente numa conversa que pertence ao vendedor (owner/assigned_to) e que está em atendimento humano (`is_human_takeover`) ou sem resposta humana: "{nome}: {trecho 80 chars}". Chave `msg:{message_id}`. Agrupe por conversa dentro de uma varredura (uma notificação por conversa por varredura, tag = conversation_id para substituir a anterior).
3. SLA em risco: atribuição pendente a ≤15 min do vencimento: "Responda {nome} — faltam N min". Chave `sla:{assignment_id}`.
- Respeitar o isolamento por vendedor: cada vendedor só recebe sobre o que é dele. Gerente (owner/admin) não recebe nada de (1)-(3) a menos que seja o dono do registro.
- Só envia se `settings.push_notifications_enabled === true`. Janela de varredura: eventos criados desde o último ciclo (cursor em memória, iniciando em `now - 2 min` ao subir) para não inundar após reinício.
- Texto sem dados sensíveis além de nome e trecho curto.

**Web (apps/web):** card "Notificações neste aparelho" em Configurações (ou menu do usuário): estado (não suportado / precisa instalar o app no iOS / permissão negada / ativo), botão "Ativar notificações" (registra SW, pede permissão, assina com a chave pública, POST /push/subscribe), botão "Enviar teste", botão "Desativar". Texto em português; no iOS fora do modo standalone, explicar "Adicionar à Tela de Início".
- Interruptor da flag `push_notifications_enabled` na seção de interruptores existente (mesmo padrão dos demais).

## Fora de escopo
Cache offline, badges de app, push para gerentes, preferências por tipo.

## Testes
Vitest nos padrões existentes: serviço de envio (410 remove, falha isolada, sem chaves = inerte), cada gatilho (dedupe, isolamento por vendedor, flag desligada), rotas (auth, upsert), componente de status. `pnpm -r typecheck` e testes dos pacotes tocados verdes.

## Restrições
- Não aplicar migration, não mexer em produção, não commitar chaves. Documentar em `docs/runbook-push-notifications.md`: como gerar VAPID (`npx web-push generate-vapid-keys`), variáveis a criar no EasyPanel (api e worker), instalação no Android/iPhone.
