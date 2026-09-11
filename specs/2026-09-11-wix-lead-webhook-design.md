# Lead do formulário Wix → Helena inicia a conversa — Design

**Data:** 2026-09-11
**Status:** Aprovado, seguindo direto para implementação (mesma sessão)

## Contexto

O site da Moto e Trilha (Wix) tem um formulário de captação de leads
(`Form_01`) que hoje só dispara um e-mail de notificação quando alguém
preenche. O e-mail contém nome, celular, e-mail, interesse, orçamento e se
já fez consórcio antes — mas ninguém entra em contato proativamente; o lead
só é atendido se e quando ele mesmo mandar mensagem no WhatsApp.

Confirmado no painel do Wix (Automations → "New submission received for
Form_01", já disparada 211 vezes): existe a ação **"Enviar solicitação
HTTP"**, que permite montar um corpo de requisição customizado, campo a
campo, e mandar via POST para uma URL externa no momento exato do envio.
Isso evita depender de leitura de e-mail (frágil, formato pode mudar).

Hoje **todo** o sistema é reativo: contato e conversa só existem depois que
o cliente manda a primeira mensagem pelo WhatsApp (`ensureConversation`,
chamado pelo webhook do Evolution). Não existe nenhum caminho hoje que crie
uma conversa e mande a primeira mensagem sem um estímulo do cliente.

## Objetivo

Quando o formulário é enviado:

1. O Wix manda os dados do lead para uma rota nova nossa.
2. Criamos o contato e a conversa (reaproveitando `ensureConversation`,
   igual ao fluxo de mensagem recebida).
3. Pré-carregamos a qualificação com o que o formulário já respondeu
   (interesse, orçamento, experiência anterior) — para a Helena não
   perguntar de novo o que o cliente já disse.
4. A Helena gera, sozinha, a mensagem de abertura (mesmo mecanismo de
   "gatilho sintético" já usado na cutucada automática) e manda pelo
   WhatsApp, na hora, pelo número já conectado.

## Fora de escopo (YAGNI) nesta versão

- **Sem suporte a outros formulários do site** além do `Form_01`. Se
  surgir outro formulário depois, é replicar o mesmo padrão.
- **Sem retry/fila própria para falha de envio ao WhatsApp** — reaproveita
  a fila de envio existente (`getSendMessageQueue`), que já tem seu próprio
  comportamento de retry.
- **Sem número de WhatsApp dedicado para esse fluxo.** Usa o mesmo número
  já conectado ("weslley"). Se o volume de leads via formulário crescer e
  isso se tornar um problema de reputação/spam junto ao WhatsApp, isso é
  revisitado depois — não é um problema hoje com o volume observado.
- **Sem tela de configuração no painel.** A URL/segredo do webhook e o
  texto do gatilho ficam no código, não editáveis pela UI — mesmo padrão
  do webhook do Evolution.

## Contrato do webhook

**Rota nova:** `POST /webhooks/wix-lead`

**Autenticação:** reaproveita o mesmo mecanismo do webhook do Evolution —
header `apikey` (ou `x-api-key`) comparado contra `WEBHOOK_SECRET` (mesma
variável de ambiente já configurada em produção). Sem segredo novo para
gerenciar.

**Corpo esperado (JSON, validado com Zod):**

```json
{
  "name": "Jenerson Moreira Dos Santos",
  "phone": "+55 62 99856-1435",
  "email": "aluiz784739@gmail.com",
  "interest": "Consórcio de Moto",
  "budget": "Mais de R$ 1.500",
  "priorExperience": "Não, vai ser a primeira vez"
}
```

- `name` e `phone`: obrigatórios.
- `email`, `interest`, `budget`, `priorExperience`: opcionais (strings
  livres — o texto exato que o cliente escolheu/escreveu no formulário).

No lado do Wix, a ação "Enviar solicitação HTTP" é configurada com
**Parâmetros do corpo → Personalizado**, mapeando cada um desses campos
para a pergunta correspondente do formulário. Isso fica documentado à
parte, para o usuário configurar manualmente na automação existente (não
é algo que o código controla).

## Fluxo de processamento

Implementado como uma função de serviço testável (`ingestWixLead`), chamada
pela rota:

1. **Normalizar telefone**: remover tudo que não for dígito; se não
   começar com `55`, prefixar. (`+55 62 99856-1435` → `5562998561435`.)
2. **Escolher agente/instância**: buscar o agente ativo da organização
   (`getAgentsByOrganization`, primeiro `is_active`) e a instância Evolution
   conectada a ele (`getInstancesByOrganization`, filtrando
   `active_agent_id`). Hoje só existe uma organização/agente/instância —
   sem seleção de UI necessária.
3. **`ensureConversation`**: cria (ou reaproveita) contato + conversa, como
   já acontece hoje para mensagens recebidas.
4. **Idempotência / não interromper conversa em andamento**: se
   `ensureConversation` retornar `isNew: false` (já existe uma conversa —
   seja porque o cliente já conversou antes, seja porque o Wix reenviou o
   mesmo webhook), **não envia nova mensagem de abertura**. Só faz o
   pré-carregamento de qualificação (idempotente) e responde 200. Isso
   evita duplicar a mensagem se o Wix reenviar por timeout, e evita
   interromper uma conversa/negociação já em curso com uma "abertura" fora
   de contexto.
5. **Pré-carregar qualificação** (só quando `isNew: true`):
   `upsertConversationQualification` com `changedByType: "human"` (trava o
   campo — é informação que o próprio cliente forneceu, não algo pra
   Helena reinterpretar):
   - `product_interest`: valor bruto de `interest`.
   - `attendance_type`: mapeado por palavras-chave em `interest`
     (`"consórcio"` → `consortium`, `"financiamento"` → `financing`,
     `"à vista"` → `cash`; sem match → não seta, deixa a Helena perguntar).
   - `commercial_notes`: `"Lead via formulário do site. Orçamento
     informado: {budget}. Já fez consórcio antes: {priorExperience}."`
     (só inclui as partes que vieram preenchidas).
6. **Gatilho sintético** (só quando `isNew: true`): mensagem `role:
   "system"` (mesmo formato de `buildFollowupNudgeMessage`) resumindo nome,
   telefone, e-mail, interesse, orçamento e experiência anterior, com a
   instrução: apresentar-se como Helena, conectar com o interesse
   demonstrado, sem repetir perguntas já respondidas no formulário.
7. **`runAgent`** com esse gatilho, `messages: []` (conversa nova, sem
   histórico), igual à chamada já usada na cutucada automática.
8. **Salvar e enviar**: `createMessage` (role `agent`) +
   `getSendMessageQueue().add(...)` + `updateConversation` atualizando
   `last_message_at` — mesmo trio de chamadas já usado no worker de
   follow-up.
9. Responder `200 { ok: true, isNew, sent }`.

## Tratamento de erros

- Payload inválido (falta `name` ou `phone`) → `400`.
- `apikey` ausente/errado → `401` (mesmo comportamento do webhook do
  Evolution).
- Se não houver agente ativo ou instância conectada na organização →
  `200 { ok: true, skipped: "no_agent" }` (não é erro do lead, é
  configuração ausente — mesmo padrão do webhook do Evolution para não
  fazer o Wix reenviar/alertar por algo que não vai se resolver retentando).
- Falha do `runAgent` (erro de API, etc.) → logada, mas **não** deixa o
  contato/conversa/qualificação sem persistir — essas escritas já
  aconteceram antes da chamada ao agente. Resultado: o lead fica registrado
  mesmo que a mensagem de abertura falhe; um humano pode assumir
  manualmente.

## Novos arquivos

- `packages/shared/src/schemas/wix-lead.ts` — `wixLeadWebhookSchema`.
- `apps/api/src/lib/wix-lead-message.ts` — `buildWixLeadTriggerMessage`
  (espelha `apps/worker/src/lib/followup-nudge.ts`).
- `apps/api/src/services/lead-intake.service.ts` — `ingestWixLead` (lógica
  principal, testável com mocks).
- `apps/api/src/routes/webhooks/wix-lead.ts` — a rota Fastify.
- Registro em `apps/api/src/server.ts`.

## Testes

- `wix-lead.ts` schema: aceita payload completo e só com campos
  obrigatórios; rejeita sem `name`/`phone`.
- `lead-intake.service.test.ts` (mockando `@aula-agente/database`,
  `@aula-agente/agent-runtime`, `@aula-agente/queue`): confirma que
  `isNew: false` pula o envio da mensagem e do `runAgent`; confirma
  mapeamento de `attendance_type` a partir de `interest`; confirma o
  formato do gatilho sintético.
- Verificação manual em produção com um envio de teste real do formulário
  antes de considerar concluído (mesmo padrão usado nas correções
  anteriores desta sessão).

## Configuração manual no Wix (fora do código)

Depois do deploy, editar a automação existente "New submission received for
Form_01" → adicionar ação "Enviar solicitação HTTP":

- Método: `POST`
- URL: `https://agente-whatsapp-api.qinw5t.easypanel.host/webhooks/wix-lead`
- Header: `apikey: <mesmo valor de WEBHOOK_SECRET em produção>`
- Corpo → Personalizado, mapeando cada campo do formulário conforme o
  contrato acima.
