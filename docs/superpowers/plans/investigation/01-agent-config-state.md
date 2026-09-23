# Investigação 1 — Estado da configuração do agente (Helena/Mariana, draft/publish, FAQ/docs, Libera Cred)

Escopo: subsistema de configuração do agente. Somente investigação, nenhuma alteração feita.

## 1. Modelo de dados: draft vs publicado

- `agent_configs` (migration `00013_agent_configs.sql`) = **rascunho editável**, uma linha por agente. Colunas: `identity`, `personality`, `rules`, `knowledge`, `playbook`, `tools_config`, `model_settings` (todos jsonb), mais `base_version_id` apontando para a última versão publicada usada como base.
- `agent_versions` (migration `00012_agent_versions.sql`) = **snapshots publicados**, versionados (`version` incremental), com `config_snapshot` (jsonb com identity/personality/rules/knowledge/playbook), `compiled_system_prompt` (texto final enviado ao LLM), `tools_config` e `model_settings` como colunas próprias (não dentro de `config_snapshot`).
- `agents.system_prompt` = **o prompt efetivamente usado em runtime**. Só é atualizado pela função `publish_agent_config` (migration `00016_publish_agent_config_function.sql`), que também grava `agents.model/provider/temperature/max_tokens/tools_config` e cria a nova linha em `agent_versions`.
- **Conclusão:** o prompt que a IA realmente usa é sempre o último publicado (`agents.system_prompt`), nunca o rascunho direto. `agent_configs` só afeta produção depois de publicar.

## 2. Nome do agente: Helena vs Mariana — CONFIRMADO, é real e está em produção

- `agents.name` = **"Helena"** (id `3ada5b0a-10b6-45fd-a210-aa42f746cc93`, `is_active=true`). Esse campo é o identificador exibido no painel/dashboard. **Nunca é tocado por `publish_agent_config`** — foi definido na criação do agente e nunca mudou.
- `agent_configs.identity.nome` = **"Mariana"**. Este campo faz parte do prompt compilado (é a auto-identificação que a IA usa: "funcao": "Consultora virtual oficial da Moto e Trilha...").
- **Isto NÃO é um rascunho não publicado.** Comparei `agent_versions.config_snapshot` da versão 56 (publicada em 2026-09-15 13:17:16, a versão atualmente ativa via `agent_configs.base_version_id`) contra o rascunho atual: os campos `identity`, `personality`, `rules`, `knowledge`, `playbook` são **byte-a-byte idênticos**. Ou seja, "Mariana" já está publicada e é o nome que a IA usa para se identificar hoje em produção, enquanto o painel mostra "Helena" como nome do agente.
- Por instrução do usuário ("se o nome correto não estiver definido no projeto, mantenha o nome da versão ativa e sinalize a divergência"): **a versão ativa (agents.name) diz "Helena"** — então "Helena" deve ser tratado como o nome correto, e `identity.nome` = "Mariana" no prompt publicado é a divergência a ser corrigida.
- Nota lateral não investigada a fundo (fora do escopo, mas fica registrada): `agents.updated_at = 2026-09-19`, quatro dias depois da versão 56 (`2026-09-15`), sem uma versão 57 correspondente em `agent_versions`. Não encontrei no código nenhum outro caminho que dê UPDATE direto em `agents` fora de `publish_agent_config`. Causa não confirmada — pode ser um trigger disparado por outra coluna, ou uma edição manual no banco. Vale investigar antes de mexer no fluxo de publish.

## 3. Alteração não publicada — CONFIRMADA, mas é outra coisa (não é o nome)

Comparando `agent_versions` (versão 56, base atual) vs `agent_configs` (rascunho atual) campo a campo:

| Campo | Status |
|---|---|
| identity | idêntico |
| personality | idêntico |
| rules | idêntico |
| knowledge | idêntico |
| playbook | idêntico |
| model_settings | idêntico |
| **tools_config.audio_voice** | **DIFERE** |

- Publicado: `"audio_voice": "shimmer"` (voz OpenAI TTS).
- Rascunho: `"audio_voice": "GDzHdQOi6jjf8zaXhCYD"` (parece um voice ID do ElevenLabs).
- Isso bate com a migration `00023_organization_secrets_elevenlabs.sql` que acabamos de aplicar em produção hoje (libera ElevenLabs como provider de TTS) — alguém trocou a voz no editor para uma voz ElevenLabs mas nunca clicou em publicar. **Hoje em produção o áudio ainda sai com a voz OpenAI "shimmer".**
- `agent_configs.updated_at = 2026-09-15 15:14:24`, ~2h depois da versão 56 (`13:17:16`) — bate com essa edição de voz feita e não publicada.

**Ação recomendada para quem for publicar depois:** ao corrigir `identity.nome` para "Helena", o publish vai automaticamente levar junto a troca de voz para ElevenLabs (é a mesma linha de rascunho). Se a troca de voz não for desejada ainda (ex: precisa configurar a secret do ElevenLabs na organização primeiro — ver `organization_secrets`), reverter `audio_voice` no rascunho antes de publicar, ou publicar em duas etapas.

## 4. FAQ e documentos "vazios" — PARCIALMENTE CONFIRMADO

Contagens reais no banco (agent_id correto, `3ada5b0a-...`):

| Tabela | Linhas |
|---|---|
| `knowledge_faqs` | **12** (todas `is_active=true`) |
| `knowledge_documents` | **0** |
| `knowledge_chunks` | **0** |

- **Documentos: realmente vazio.** Nenhum documento foi enviado (`knowledge_documents` = 0 linhas). Não é bug, é ausência real de dados.
- **FAQ: NÃO está vazio no banco** — 12 perguntas ativas, todas com `agent_id` correto. Revisei o código do painel (`apps/web/src/components/agents/config/conhecimento-section.tsx:31-32`) que faz `supabase.from("knowledge_faqs").select("*").eq("agent_id", agentId)` — a query está correta e usa o mesmo `agentId` da rota. RLS está habilitado nessas tabelas (`00008_rls_policies.sql`) seguindo o mesmo padrão genérico por organização usado em outras tabelas que funcionam. **Não encontrei uma causa técnica reproduzível para o FAQ aparecer vazio no painel.** Hipóteses não confirmadas: bug transitório de carregamento no navegador do usuário, ou ele visualizou a aba "Documentos" (essa sim vazia) e associou a observação também ao FAQ. Recomendo pedir um print de tela antes de investigar mais fundo aqui — é o único item desta parte que não consegui confirmar nem descartar com certeza.
- Ferramentas de busca: `tools_config.search_faq = true` e `search_knowledge = true` publicados — as ferramentas estão mesmo ativas, confirma a observação do usuário nesse ponto.
- **Bug de dado encontrado de passagem (fora do pedido, mas no meio dos FAQs de Libera Cred):** uma pergunta está corrompida/concatenada: `"Preciso comprovar renda para fazeVocês fazem consórcio de carro?r o LiberaCred?"` — parece duas perguntas diferentes coladas incorretamente (provavelmente um bug de paste/edição no formulário do FAQ manager). Vale corrigir separadamente.

## 5. Tabela do Libera Cred duplicada — CONFIRMADO

Menções a "LiberaCred"/"Libera Cred" por seção do prompt publicado (versão 56):

| Seção | Ocorrências |
|---|---|
| `rules` | 20 |
| `playbook` | 10 (inclui um bloco inteiro "PLAYBOOK LIBERACRED") |
| `knowledge` | 3 |
| `personality` | 1 |
| `knowledge_faqs` (tabela separada) | 4 perguntas |

**A tabela de preços/parcelas está fisicamente duplicada em dois lugares, com os mesmos 13 modelos e os mesmos valores** (conferido campo a campo, ex: ZR Hybrid Connected R$ 535,10, Fluo ABS Hybrid Connected R$ 637,07, Factor 150 R$ 698,99 — idênticos nos dois locais):

1. Em `knowledge`, como uma tabela de referência dedicada.
2. Em `rules`, dentro de um item chamado `"id": "liberacred-tabela-parcelas"` — a mesma tabela, colada novamente dentro de uma regra de negócio.

Além disso `playbook` tem um bloco de instruções operacionais completo sobre quando oferecer o LiberaCred, como responder lead de campanha, etc — que se sobrepõe conceitualmente com as regras em `rules` (mesmo assunto, fontes diferentes).

**Boa notícia:** hoje os dois lugares têm os mesmos números — não há divergência de valores ainda. Mas é um risco real de drift (se alguém atualizar um preço em um lugar e esquecer o outro) e é exatamente o padrão de duplicação que o usuário descreveu. Consolidar em uma única fonte (recomendo `knowledge`, já que é onde faz mais sentido semanticamente ficar uma tabela de referência) e fazer `rules`/`playbook` apontarem para ela por instrução, não por cópia.

## Resumo do que está confirmado vs em aberto

**Confirmado e pronto para virar tarefa de correção:**
- Nome "Mariana" vs "Helena": divergência real, já publicada, afeta produção agora.
- Alteração de voz de áudio não publicada (shimmer → ElevenLabs voice id).
- Tabela de preços do LiberaCred duplicada em `knowledge` e `rules` (mesmos valores hoje, risco de drift).
- Documentos genuinamente vazios (0 uploads).
- FAQ corrompido: uma pergunta com texto concatenado incorretamente.

**Em aberto / precisa de decisão humana:**
- Por que `agents.updated_at` mudou em 2026-09-19 sem uma versão 57 correspondente — não encontrei a causa no código.
- FAQ "aparecendo vazio" no painel: não reproduzi o bug — dado e query parecem corretos. Pode não ser um bug real, ou pode ter sido a aba de documentos.
- Se a troca de voz para ElevenLabs deve ir junto na próxima publicação, ou ser revertida até a secret do ElevenLabs estar configurada na organização (não verifiquei se `organization_secrets` já tem uma chave ElevenLabs cadastrada para esta org — fora do escopo desta investigação).
