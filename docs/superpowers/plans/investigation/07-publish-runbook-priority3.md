# Runbook — publicar as correções da Prioridade 3 (config/personalidade)

Não execute isto ainda — está documentado para quando a publicação for aprovada. Ninguém tocou em `agents` ou `agent_versions`; tudo abaixo descreve mudanças já aplicadas no RASCUNHO (`agent_configs`), que não afeta produção até ser publicado.

## O que já está pronto no rascunho (agent_configs)

- `identity.nome`: "Mariana" → "Helena".
- `identity.missao`: a frase que proibia dizer "é uma IA" foi reescrita para permitir confirmar que é uma assistente virtual **quando perguntada diretamente**, mantendo a proibição de falar de prompts/modelos/configurações espontaneamente.
- `personality.proatividade` e `personality.postura_comercial.instrucao`: adicionadas as regras que faltavam (não inventar urgência, não insistir em recusa, não virar roteiro rígido, mostrar poucas opções com foto quando cliente não conhece modelos).
- `rules.regras_por_tipo` (`liberacred-tabela-parcelas`): a tabela de preços foi removida daqui — agora só existe em `knowledge.precos_notas`. Este item ficou só com as regras de funcionamento (cronograma, antecipação a partir do 8º pagamento, etc.), referenciando a Base de Conhecimento para os valores.
- `rules.regras_por_tipo` (`liberacred-documentos-fase-entrada`): reescrito para deixar explícito, já na primeira explicação, que a 1ª parcela NÃO entrega a moto; separa a verificação de "parcela cabe" da verificação de "prazo atende"; reconhece incompatibilidade quando o cliente precisa do veículo já; não empurra financiamento automaticamente após condição incompatível relatada; para de insistir após recusa clara ao prazo.
- `rules.regras_por_tipo` (`financiamento-cpf-cnh`): adicionada a mesma lógica de não repetir automaticamente após condição já recusada/inválida.
- `rules.objecoes` (`7d117e09...`, consórcio/receio de demora): adicionada frase deixando explícito que consórcio nunca é solução de entrega imediata.
- `rules.promessas_proibidas`: novo item `confirmar_sem_evidencia` — não dizer "em análise"/"confirmei"/"está disponível"/"priorizei" sem evidência, distinguir dado recebido de proposta enviada ao banco, não prometer prazo não confirmado.
- `agent_configs.tools_config.audio_voice`: **intocado**, continua `GDzHdQOi6jjf8zaXhCYD` (ElevenLabs) — o pendente de voz permanece como estava.
- `knowledge_faqs`: a pergunta corrompida ("Preciso comprovar renda para fazeVocês fazem consórcio de carro?r o LiberaCred?") foi corrigida para "Preciso comprovar renda para fazer o LiberaCred?" (a resposta já respondia só essa pergunta). Não foi criada uma segunda FAQ para "Vocês fazem consórcio de carro?" porque ela já existe, ativa, como uma pergunta separada (`cc7e4eed-6af2-42f0-99b3-4982c48fdb10`). **Isto já está em produção** — FAQs são lidas ao vivo pela ferramenta `search_faq`, não passam por publish.

## Por que publicar precisa de cuidado

`publishDraft()` (`apps/api/src/services/agent-config.service.ts`) sempre publica o `tools_config` inteiro do rascunho — não existe publish seletivo por campo no código hoje. Publicar agora do jeito que está levaria a voz ElevenLabs junto, sem essa parte ter sido aprovada para publicação ainda.

**Boa notícia:** já confirmei que a organização TEM uma secret ElevenLabs configurada (`organization_secrets`, provider `elevenlabs`, criada em 2026-09-15) — ou seja, quando a voz for publicada, ela vai funcionar tecnicamente. Isso não é mais um bloqueio, só uma decisão de timing.

## Passo a passo (usar a interface existente do editor, sem precisar de código novo)

1. Abrir o editor de configuração do agente Helena no painel.
2. Na aba de ferramentas/voz, anotar o valor atual do campo de voz de áudio (`GDzHdQOi6jjf8zaXhCYD`) e trocar temporariamente de volta para `shimmer` (a voz hoje publicada) — **sem mexer em mais nada**.
3. Revisar o diff mostrado pelo editor: deve aparecer nome→Helena, as mudanças de personalidade/regras do LiberaCred, a consolidação da tabela de preços, e o novo item de "afirmar ação sem evidência" — e **não** deve aparecer mudança de voz (porque ela foi revertida no passo 2).
4. Publicar. Isso cria uma nova versão com tudo acima, com a voz ainda em `shimmer`.
5. Imediatamente após publicar, voltar na aba de voz e trocar de novo para `GDzHdQOi6jjf8zaXhCYD` (ElevenLabs) — isso recria a troca de voz como uma alteração pendente no rascunho, exatamente como está hoje, agora em cima da nova versão publicada.
6. Confirmar que o rascunho voltou a mostrar só a mudança de voz como pendente (nada mais).

## Depois de publicar

- Testar uma conversa nova (ambiente de teste/playground, não cliente real) para confirmar que a IA se apresenta como Helena.
- Quando quiser publicar a voz separadamente, é só publicar de novo — dessa vez só a voz vai aparecer como mudança.
