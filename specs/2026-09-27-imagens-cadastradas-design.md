# Imagens cadastradas no Conhecimento da Helena — design

**Data:** 2026-09-27
**Status:** aprovado em conversa (abordagem A), aguardando revisão desta spec

## Objetivo

Permitir que a Helena envie pelo WhatsApp uma imagem previamente cadastrada no painel quando a situação descrita no cadastro acontecer. Primeiro caso de uso: a arte "catálogo Libera Cred" (`catalogo_motos_plano.png`, 13 modelos com preço de referência) quando o cliente pedir o catálogo, todas as motos ou as opções do Libera Cred.

**Pedido do usuário:** "quando cliente pergunta de catálogo do liberacred podemos enviar uma imagem cadastrada"; arte única com preços; abordagem A (lista genérica no Conhecimento, versionada com a publicação).

**Critérios de sucesso**
- Cadastrar/trocar/remover a imagem pelo painel, sem código.
- A imagem só passa a valer para clientes depois de publicar (mesmo ciclo rascunho → versão da tabela de preços).
- Pedido de catálogo Libera Cred → Helena envia a arte com legenda e informa parcelas em texto pela tabela; nunca trata o valor da arte como preço à vista.
- Mecanismo reaproveitável para outros materiais (folder de consórcio, mapa da loja) sem nova ferramenta.

## Fora de escopo

- Vídeo, PDF ou áudio cadastrados (só imagem).
- Várias imagens por envio / álbum.
- Apagar arquivos do Storage ao remover da lista (versões antigas e histórico de mensagens apontam para eles).
- Mudar a ferramenta de foto do catálogo de veículos (`sendVehiclePhoto`).

## Design

### 1. Dados (`packages/shared`)

`AgentKnowledgeConfig` ganha `imagens: AgentImageItem[]` (default `[]`, então rascunhos/versões antigos continuam válidos):

```ts
interface AgentImageItem {
  id: string;              // uuid gerado no upload; é o que a Helena usa para pedir o envio
  titulo: string;          // max 150 — ex.: "Catálogo Libera Cred"
  quando_enviar: string;   // max 500 — ex.: "cliente pede o catálogo, todas as motos ou as opções do Libera Cred"
  legenda: string;         // max 1000 — texto enviado junto com a imagem no WhatsApp
  url: string;             // URL pública do Storage
  storage_path: string;    // org/agente/uuid.ext — para trocar/auditar
  ativo: boolean;
}
```

Schema zod equivalente em `agentKnowledgeConfigSchema` (`imagens: z.array(...).max(20).default([])`).

`ToolsConfig` ganha `send_registered_image?: boolean` (opcional: linhas antigas não têm; ausente = desligado). No schema: `z.boolean().default(false)`.

### 2. Storage e upload (`supabase`, `apps/api`)

- Migração `00026_agent_media_bucket.sql`: cria bucket **público** `agent-media` (a Evolution API baixa a mídia pela URL). Tamanho máx. 5 MB, MIME `image/png`, `image/jpeg`, `image/webp`. Escrita só pelo service role (API); sem policy de escrita para clientes.
- Rota `POST /organizations/:organizationId/agents/:agentId/config/images` (multipart, mesmo padrão de `routes/knowledge/documents.ts`: `authMiddleware`, papel ≠ `agent`). Valida tipo e tamanho, grava em `{organizationId}/{agentId}/{uuid}.{ext}` e responde `{ id, url, storage_path }`. **Não** altera o rascunho — o painel adiciona/atualiza o item em `knowledge.imagens` e salva pelo fluxo normal do rascunho.
- Trocar arquivo = novo upload (novo path) e o item passa a apontar para ele; arquivos antigos ficam no bucket.

### 3. Prompt (`packages/shared/src/prompt-builder.ts`)

`compileKnowledgeSection` acrescenta, se houver imagens ativas:

```
# Imagens cadastradas
Envie com a ferramenta sendRegisteredImage usando o id. Envie cada imagem no máximo uma vez por conversa, salvo se o cliente pedir de novo.
- id: <id> | <titulo> | Quando enviar: <quando_enviar>
```

A URL não entra no prompt (evita o modelo inventar/colar link).

### 4. Ferramenta (`packages/agent-runtime`)

`sendRegisteredImage({ imagem_id })`, registrada quando `tools_config.send_registered_image` estiver ligado:

1. Lê a **versão publicada mais recente** do agente (`agent_versions.config_snapshot.knowledge.imagens`) — nunca o rascunho e nunca um valor lembrado pelo modelo.
2. Não encontrada ou inativa → retorna mensagem dizendo que não existe/está desativada e que não deve dizer ao cliente que enviou.
3. Encontrada → `createMessage` (role `agent`, `content` = legenda, `media_url`, `media_type: "image"`) e enfileira `send-message` com `mediaUrl` e `caption`, exatamente como `sendVehiclePhoto`. Retorna "Imagem enviada.".

No playground (`sandbox: true`) usa versão simulada que lê do **rascunho** e retorna `[SIMULADO] Imagem "<titulo>" seria enviada...` — assim o teste antes de publicar reflete o que está sendo editado.

### 5. Painel (`apps/web`)

- `SECTION_ITEMS.conhecimento` ganha `imagens: "Imagens"`.
- Editor em `conhecimento-section.tsx` (ou componente próprio ao lado): lista com miniatura, título, quando enviar, legenda, ativo; botões "Adicionar imagem" (upload → cria item), "Trocar arquivo", "Remover" (tira da lista; não apaga do bucket).
- `ferramentas-section.tsx`: chave "Enviar imagens cadastradas".
- O diff/publicação existente já cobre `knowledge` inteiro e `tools_config`.

### 6. Conteúdo inicial (após deploy)

- Upload de `catalogo_motos_plano.png` (13 preços conferidos com a tabela de 23/09/2026 em 2026-09-27).
- Item: título "Catálogo Libera Cred"; quando enviar "cliente pede o catálogo, todas as motos ou as opções do Libera Cred"; legenda "Motos do plano Libera Cred — preços de referência do plano (tabela 23/09/2026). A parcela depende do prazo escolhido."
- Regra "LiberaCred — apresentação dos modelos": ao enviar a arte, informar as parcelas do prazo em texto pela tabela; os valores da arte são preço de referência do plano, não preço à vista; quando a tabela mudar, a arte precisa ser trocada na mesma publicação.
- Ligar `send_registered_image` e publicar (com aprovação do usuário).

## Erros e bordas

- Upload inválido (tipo/tamanho) → 400 com mensagem; nada gravado.
- Falha ao enfileirar/gravar mensagem → ferramenta retorna erro e instrui a não afirmar envio (mesmo padrão de "Afirmar ação sem evidência").
- Imagem removida entre publicação e envio → tratada como "não encontrada" na versão publicada.
- Rascunho sem `imagens` (antigo) → default `[]`.

## Testes

- Schema: item válido, limites de tamanho, default `[]`, `send_registered_image` default `false`.
- Prompt builder: lista só ativas, sem URL; seção omitida sem imagens.
- Ferramenta: lê versão publicada; não encontrada; inativa; envio cria mensagem + job com `mediaUrl`/`caption`; mock do sandbox lê rascunho.
- Registry: registra só com a chave ligada.
- Rota de upload: sem arquivo, tipo inválido, > 5 MB, sucesso (Storage mockado), 403 para papel `agent`.
- Validação ponta a ponta no playground antes de publicar: "me manda o catálogo do Libera Cred", "quais motos tem?", pedido de uma moto específica (não deve mandar a arte inteira sem necessidade).
