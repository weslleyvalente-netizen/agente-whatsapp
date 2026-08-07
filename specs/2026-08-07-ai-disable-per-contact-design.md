# Desativar a IA permanentemente por contato — Design

## Contexto

Hoje existe um mecanismo de "Assumir Conversa" (`conversations.is_human_takeover`)
que pausa a Helena numa conversa específica. Ele tem duas limitações
deliberadas para o caso de uso que motivou esta spec:

1. **É por conversa, não por contato.** Se o mesmo número de telefone abrir
   uma conversa nova, a Helena volta a responder normalmente.
2. **Expira sozinho.** `apps/worker/src/workers/takeover-timeout.ts` roda a
   cada 5 minutos e zera `is_human_takeover` depois de
   `human_takeover_timeout_minutes` (padrão 30 min) sem nenhum humano
   responder — a Helena retoma o atendimento sozinha.

O pedido: uma forma de desativar a Helena **permanentemente** para um
contato específico — sem expirar, valendo para qualquer conversa futura com
aquele número, até que um humano reative explicitamente.

## Modelo de dados

Nova migration adicionando três colunas a `wa_contacts`
(`supabase/migrations/00003_wa_contacts.sql` é a definição atual da tabela,
sem nenhuma dessas colunas hoje):

```sql
ALTER TABLE wa_contacts
  ADD COLUMN ai_disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_disabled_at timestamptz,
  ADD COLUMN ai_disabled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
```

`ai_disabled_by` segue o mesmo padrão já usado em `conversations.assigned_to`
(`uuid REFERENCES auth.users(id) ON DELETE SET NULL`) — referência direta a
`auth.users`, sem tabela de usuários própria nem `organization_members.id`.

Não há tabela de histórico/auditoria — apenas o estado atual (ligado/desligado
+ quando + por quem foi a última mudança), decisão explícita para manter o
escopo pequeno. Se um dia for necessário auditar mudanças ao longo do tempo,
isso é uma extensão futura, não parte desta spec.

`wa_contacts` já tem RLS completa via o loop em
`supabase/migrations/00008_rls_policies.sql` (`SELECT`/`INSERT`/`UPDATE`/`DELETE`
todos com `organization_id IN (SELECT get_user_org_ids())`) — nenhuma policy
nova é necessária para essas três colunas.

## Onde a escrita acontece

Direto do cliente via Supabase JS, no mesmo padrão que
`handleTakeoverToggle()` já usa hoje em
`apps/web/src/components/inbox/chat-panel.tsx` (escreve direto em
`conversations` sem passar pela API Fastify). `wa_contacts` nunca teve uma
rota REST própria em `apps/api/src/routes` — criar uma agora, só para esta
feature, seria escopo desnecessário quando o padrão existente já resolve via
RLS.

## Bloqueio da IA — dois pontos de guarda

Ambos já têm acesso ao dado da nova coluna sem precisar mudar nenhuma query:

**`apps/worker/src/workers/process-message.ts`** — o guard atual:

```ts
        // Check if still not in human takeover
        const conversation = await getConversationById(db, conversationId);
        if (conversation.is_human_takeover) {
          console.log(`Conversation ${conversationId} is in human takeover, skipping`);
          return;
        }
```

`getConversationById` (`packages/database/src/queries/conversations.ts:34-42`)
já faz `.select("*, wa_contacts(*), agents(name)")` — o objeto retornado já
tem `conversation.wa_contacts.ai_disabled` disponível. O guard ganha uma
segunda condição:

```ts
        const conversation = await getConversationById(db, conversationId);
        if (conversation.is_human_takeover) {
          console.log(`Conversation ${conversationId} is in human takeover, skipping`);
          return;
        }
        if (conversation.wa_contacts?.ai_disabled) {
          console.log(`Conversation ${conversationId} contact has AI permanently disabled, skipping`);
          return;
        }
```

**`apps/api/src/routes/webhooks/evolution.ts`** — o guard de enfileiramento
(linhas ~171-181 hoje):

```ts
      // If human takeover is active, don't enqueue for LLM processing
      if (conversation.is_human_takeover) {
        return reply.status(200).send({ ok: true, skipped: "human_takeover" });
      }
```

`contact` nesse arquivo vem de `ensureConversation()` →
`upsertContact()` (`packages/database/src/queries/contacts.ts:20-34`), que
termina em `.select().single()` — sem argumentos, ou seja `*`, então
`contact.ai_disabled` já está disponível sem mudar a query. O guard ganha a
mesma segunda condição:

```ts
      if (conversation.is_human_takeover) {
        return reply.status(200).send({ ok: true, skipped: "human_takeover" });
      }
      if (contact.ai_disabled) {
        return reply.status(200).send({ ok: true, skipped: "ai_disabled" });
      }
```

Nenhuma mudança no `takeover-timeout.ts` — o timeout de 30 min continua
existindo e continua zerando `is_human_takeover` normalmente. Quem garante o
bloqueio permanente é `ai_disabled`, um mecanismo totalmente independente do
takeover temporário.

## UI — cabeçalho do chat (`chat-header.tsx`)

### Estado normal (`ai_disabled = false`)

O botão "Assumir Conversa"/"Devolver ao Agente" existente
(`apps/web/src/components/inbox/chat-header.tsx`, atualmente entre
`AssignSelect` e `TaskDialog`) continua exatamente como está. Ganha um vizinho:
um botão `⋮` novo que abre um `DropdownMenu`
(`apps/web/src/components/ui/dropdown-menu.tsx`, já usado no painel de
Tarefas para Reagendar/Cancelar) com um único item:

```
Desativar IA permanentemente
```

com estilo destrutivo (`<DropdownMenuItem variant="destructive">`, mesmo
padrão do "Cancelar tarefa" no painel de Tarefas).

Ao clicar, sem confirmação extra (um clique só, mesmo padrão do "Assumir
Conversa" hoje):

```ts
const handleDisableAi = async () => {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  await supabase
    .from("wa_contacts")
    .update({
      ai_disabled: true,
      ai_disabled_at: new Date().toISOString(),
      ai_disabled_by: user?.id,
    })
    .eq("id", conversation.wa_contacts.id);

  await supabase
    .from("conversations")
    .update({
      is_human_takeover: true,
      human_takeover_at: new Date().toISOString(),
      assigned_to: user?.id,
    })
    .eq("id", conversation.id);

  onUpdate();
};
```

A segunda escrita (em `conversations`) é deliberadamente idêntica ao que
`handleTakeoverToggle()` já faz para ligar o takeover — reaproveita o mesmo
efeito ("a conversa atual fica atribuída a você imediatamente"), sem
duplicar lógica nova além da união dos dois updates.

### Estado desativado (`ai_disabled = true`)

O botão de takeover temporário ("Assumir Conversa"/"Devolver ao Agente")
**some**. No lugar aparece:

```
Reativar IA
```

Clicar abre um `confirm()` nativo simples (mesmo padrão do "Cancelar tarefa"
hoje: `if (!confirm("Reativar a IA para este contato?")) return;`) antes de
zerar as três colunas:

```ts
const handleReenableAi = async () => {
  if (!confirm("Reativar a IA para este contato?")) return;
  const supabase = createClient();

  await supabase
    .from("wa_contacts")
    .update({ ai_disabled: false, ai_disabled_at: null, ai_disabled_by: null })
    .eq("id", conversation.wa_contacts.id);

  onUpdate();
};
```

Reativar não mexe em `is_human_takeover`/`assigned_to` da conversa atual —
os dois mecanismos são independentes. Se `is_human_takeover` ainda estiver
`true` (não expirou ainda), o botão de takeover temporário volta a aparecer
mostrando "Devolver ao Agente", como já seria o comportamento normal.

### Aviso "O agente está atendendo"

A barra de aviso em `chat-panel.tsx` (linhas ~174-179 hoje):

```tsx
{conversation && !conversation.is_human_takeover && (
  <div className="border-t bg-destructive/10 px-4 py-2 text-xs text-destructive">
    O agente está atendendo. Enviar uma mensagem atribui a conversa a você e pausa o agente e as automações.
  </div>
)}
```

passa a considerar também `ai_disabled`, senão mentiria para o atendente
depois que o takeover de 30 minutos expirar sozinho enquanto a IA continua
permanentemente desativada:

```tsx
{conversation && !conversation.is_human_takeover && !conversation.wa_contacts?.ai_disabled && (
  <div className="border-t bg-destructive/10 px-4 py-2 text-xs text-destructive">
    O agente está atendendo. Enviar uma mensagem atribui a conversa a você e pausa o agente e as automações.
  </div>
)}
```

## UI — lista de conversas (`conversation-list.tsx`)

`getConversationTags()` (linhas ~39-53 hoje) ganha um branch novo, ao lado
do existente para `is_human_takeover`:

```ts
function getConversationTags(
  conv: ConversationItem
): Array<{ label: string; kind: "badge"; variant: "tonal" | "destructive" } | { label: string; kind: "text" }> {
  const tags = [];
  if (conv.status === "open" || conv.status === "waiting") {
    tags.push({ label: "Em andamento", kind: "badge", variant: "tonal" });
  }
  if (conv.wa_contacts?.ai_disabled) {
    tags.push({ label: "IA desativada", kind: "badge", variant: "destructive" });
  }
  if (conv.is_human_takeover) {
    tags.push({ label: "Atenção Humana", kind: "badge", variant: "destructive" });
    if (!conv.assigned_to) {
      tags.push({ label: "Disponível para assumir", kind: "text" });
    }
  }
  return tags;
}
```

Isso exige que `ConversationItem` (linhas ~9-25 hoje) inclua `ai_disabled`
dentro do objeto `wa_contacts` aninhado. A query que popula a lista
(`apps/web/src/app/(dashboard)/inbox/page.tsx:49`) hoje é:

```ts
.select("*, wa_contacts(phone, name), agents(name), messages(content, created_at)")
```

e passa a ser:

```ts
.select("*, wa_contacts(phone, name, ai_disabled), agents(name), messages(content, created_at)")
```

Nenhuma mudança no `StatusLamp`/lâmpada pulsante — o indicador novo usa o
padrão de `Badge`, já existente, sem precisar de um componente visual novo.

## Fora de escopo

- Histórico/auditoria de mudanças (tabela de eventos) — só o estado atual.
- Painel/ficha de contato dedicado — o controle vive no cabeçalho do chat.
- Qualquer mudança no timeout de 30 min do takeover temporário — continua
  existindo e funcionando exatamente como hoje, mecanismo independente.
- Rota REST nova em `apps/api` para `wa_contacts` — a escrita é direta via
  Supabase JS, mesmo padrão do takeover temporário.
- Confirmação ao **desativar** — só ao **reativar**, por pedido explícito.

## Validação mínima

1. Desativar a IA numa conversa aberta → conversa atual vira takeover
   atribuído a quem desativou; nova mensagem do mesmo número em qualquer
   conversa (existente ou nova) não aciona a Helena.
2. Aguardar o takeover expirar (ou simular via banco) enquanto `ai_disabled`
   continua `true` → aviso "O agente está atendendo" não deve reaparecer; a
   Helena continua não respondendo.
3. Reativar a IA → `confirm()` aparece; confirmando, as 3 colunas voltam a
   `false`/`null`/`null`; nova mensagem do contato volta a acionar a Helena
   normalmente (assumindo que `is_human_takeover` da conversa em questão já
   tenha expirado ou tenha sido devolvido manualmente).
4. Badge "IA desativada" aparece na lista de conversas para esse contato em
   qualquer conversa dele, não só na que estava aberta quando foi desativado.
5. Nenhuma mudança de comportamento para contatos com `ai_disabled = false`
   (padrão) — takeover temporário, timeout de 30 min, e todo o resto do
   fluxo existente continuam idênticos.
