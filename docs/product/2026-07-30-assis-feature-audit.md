# Auditoria de funcionalidades — Assis vs. aula-agente

**Data:** 2026-07-30
**Contexto:** Assis (`next.assis.co`) é o SaaS pago que a Moto e Trilha usa hoje
para atendimento via WhatsApp. O `aula-agente` (Helena) é o que estamos
construindo para substituir essa assinatura. Este documento é um
levantamento do que o Assis oferece, comparado ao que já existe no
`aula-agente`, para orientar prioridades futuras. Não é uma spec de
implementação — é a base para decidir o que vale a pena virar spec.

Levantamento feito navegando ao vivo no Assis, logado como a própria conta
da Moto e Trilha (mesmo cliente final, mesmo agente "Helena", mesmo número
de WhatsApp usados nos dois sistemas).

## Resumo executivo

O Assis é significativamente mais maduro em **configuração do agente**
(sistema de arquivos/skills conversacional), **analytics** (cohort, motivos
de handoff) e **geração de documentos** (Artefatos). O `aula-agente` já tem
paridade ou vantagem em **integração de catálogo de veículos** (busca
automática vs. upload manual) e está construindo algo equivalente ao
"Treinar Helena" com o Trainer. Maiores gaps: Analytics dedicado, Artefatos
(documentos gerados sob demanda), Campanhas (outbound em massa), e o modelo
de configuração baseado em arquivos/skills.

## Seção por seção

### 1. Dashboard (`/dashboard`)
- 4 KPIs: Conversas (7 dias), Em andamento, Tempo de resposta, Precisam de
  atenção.
- Lista "Tarefas urgentes" — feed simples de conversas com tag
  Urgente/Nova, ordenadas por recência.
- **Comparação:** o `aula-agente` já tem uma home de dashboard equivalente
  (`specs/2026-07-21-dashboard-home-inicio-design.md`) com cards de
  overview. Não vimos o resultado ao vivo pra comparar 1:1, mas a forma é
  parecida (KPIs + lista do que precisa de atenção agora).

### 2. Chats (`/chats`)
- Lista de conversas com filtros: Todas / Minhas / Agente / Outros /
  Atenção.
- Tags por conversa: "Em andamento", "Atenção Humana", "disponível para
  assumir", "Convertido".
- Ações no header da conversa: Atribuir responsável, Reativar agente,
  Assumir conversa, Histórico de ownership, Fechar conversa.
- **Comparação:** o Inbox do `aula-agente`
  (`specs/2026-07-22-inbox-layout-and-auto-takeover-design.md`) já cobre
  auto-takeover e a mecânica de "IA pausa quando humano assume". O Assis
  tem "Histórico de ownership" como painel dedicado (auditoria de quem
  assumiu/devolveu a conversa e quando) — não confirmamos se isso existe no
  nosso lado.

### 3. Analytics (`/analytics`) — **gap grande**
- KPIs: Total de conversas, Em andamento, Precisam de atenção (com período
  configurável, ex. "30 dias").
- Gráfico de linha "Respostas ao longo do tempo" com toggle
  Respostas/Conversões.
- Donut "Auto-resolvidas" (% de conversas que a IA resolveu sem humano) +
  contagem "Só IA respondeu" vs. "Humano interveio".
- "Tempo até 1ª resposta · mediana" (p50).
- **"Motivos do handoff humano"** — top 5 razões pelas quais a própria IA
  pediu ajuda humana, cada uma com um resumo gerado por IA de 1 linha e o
  % de casos. Isso é gerado a partir do conteúdo real das conversas, não
  uma categoria fixa.
- "Última atividade" — feed das 5 conversas mais recentes.
- **"Retenção por cohort"** — matriz semana a semana de
  Responderam/Engajaram (3+ msgs)/Converteram, no estilo de cohort
  analysis de growth/produto.
- **Comparação:** o `aula-agente` não tem nada equivalente a uma tela de
  Analytics hoje. É o gap mais visível — especialmente "motivos do
  handoff" (ajuda a entender por que a IA está travando) e a taxa de
  auto-resolução (métrica de valor pra vender a substituição do Assis pro
  próprio dono do negócio).

### 4. Agentes (`/agents`) — **gap grande na configuração**
- Lista de "Agentes em operação" (a Moto e Trilha tem 1: Helena) +
  "Modelos disponíveis" — templates prontos por categoria (Vendas, Análise
  de dados, Marketing), ex. "SDR Inbound" (qualifica quem chega) e "SDR
  Outbound" (retoma leads parados). Sugere suporte a múltiplos agentes
  especializados por organização, não só um agente genérico.
- **Tela "Treinar Helena"** tem 5 abas:
  - **Conversar** — chat em linguagem natural pra ajustar o agente ("muda
    o tom", "anexe um PDF de preços") — o próprio meta-assistente decide
    como isso vira mudança de configuração, e explica antes de aplicar
    (vimos um exemplo real de raciocínio sobre uma regra ambígua antes de
    perguntar pro usuário como resolver).
  - **Editar** — visão de arquivos: `agent`, `voice`, `guardrails` na
    raiz; pastas `skills/` (precos, faq, links), `playbooks/` (script),
    `personalidade/` (emojis, perguntas-por-vez, postura-comercial). Cada
    arquivo é editável, com tamanho em KB mostrado. Dentro do arquivo
    `agent`: seções estruturadas tipo "Identidade" (nome) e "Tom de voz"
    (Profissional/Equilibrado/Amigável/Divertido + tamanho de resposta
    Curta/Média/Detalhada).
  - **MCPs** — conectar o agente a integrações externas (CRMs, ERPs) via
    servidor MCP, por agente.
  - **Canais** — números de WhatsApp atribuídos a esse agente específico
    (permite restringir "quem pode falar"), conexão de e-mail, Instagram
    ("em breve").
  - **Rotinas** — relatórios recorrentes que esse agente envia por e-mail
    em horário agendado.
  - Painel lateral "Playground" com teste ao vivo do agente (chat de
    simulação) sempre visível enquanto você edita.
- **Comparação:** o `aula-agente` tem o Trainer
  (`specs/2026-07-27-helena-trainer-design.md`,
  `specs/2026-07-25-helena-config-central-design.md`) que já é
  conceitualmente parecido com a aba "Conversar" (chat que propõe mudanças,
  usuário aprova). A diferença grande é o modelo de **arquivos/skills
  organizados em pastas** do Assis — mais granular e navegável que um
  `system_prompt` único + toggles de tools que temos hoje. Vale avaliar se
  o Trainer deveria evoluir pra esse modelo de arquivos, ou se o approach
  atual (um prompt + tools) é suficiente pro estágio atual do produto.

### 5. Campanhas (`/campanhas`) — **não existe no aula-agente**
- Outbound em massa: "Campanhas conectam um agente a uma audiência e a um
  conjunto de instruções. Você sobe a lista de contatos, a gente checa
  quem pode receber, e o agente assume o atendimento."
- Vazio na conta da Moto e Trilha (nunca usaram).
- **Comparação:** feature que não existe no `aula-agente`. Baixa prioridade
  imediata dado que nem o cliente atual usa, mas é uma peça de produto
  relevante pra reter clientes que fazem outbound ativo.

### 6. Rotinas (`/rotinas`) — **não existe no aula-agente**
- "O agente executa uma tarefa no horário programado e envia o resultado
  por e-mail." Mesma feature vista dentro de Agentes > Rotinas, aqui numa
  visão consolidada de todas as rotinas da organização.
- Vazio na conta atual.

### 7. Mídias (`/midias`)
- Biblioteca de arquivos (imagens) organizados em pastas (ex: "Carros",
  "Bicicletas Eletricas"), cada um com descrição obrigatória — "é por ela
  que o agente decide quando usar a mídia". Upload manual.
- Na conta real, só 2 imagens cadastradas (Celta, bicicleta elétrica).
- **Comparação:** o `aula-agente` está **à frente** aqui — o
  `searchCatalog`/`sendVehiclePhoto`
  (`specs/2026-07-23-agent-vehicle-catalog-photo-design.md`) puxa
  automaticamente as 27 fotos do catálogo real da Moto e Trilha via API,
  sem upload manual por veículo. O Assis não tem essa integração — por
  isso só 2 mídias cadastradas manualmente, claramente sub-utilizado.

### 8. Artefatos (`/artefatos`) — **não existe no aula-agente**
- Templates HTML com placeholders Handlebars (`{{ campo }}`). Cada
  artefato vira automaticamente uma tool que o agente pode chamar,
  preenchendo as variáveis certas a partir da conversa, e devolve um link
  público pra mandar no WhatsApp. Casos de uso citados: cotações,
  contratos, recibos.
- Vazio na conta atual (nenhum artefato criado ainda).
- **Comparação:** feature interessante e não trivial — geração de
  documento sob demanda como uma tool dinâmica. Não existe equivalente no
  `aula-agente`. Poderia resolver, por exemplo, gerar uma proposta de
  financiamento formatada em vez de só texto corrido no chat.

### 9. Integrações (`/integrations`)
- **Canais de comunicação:** WhatsApp (via **Cloud API oficial do Meta**,
  não Evolution API) — já conectado; Gmail (ler/responder e-mail).
- **CRM:** Pipedrive, HubSpot, GoHighLevel — todos "Indisponível" no plano
  atual (via MCP).
- **Marketing:** Meta Ads — leitura de investimento/ROAS/conversões via
  MCP, disponível pra autorizar.
- **Produtividade:** Trinks (agenda de serviços — indisponível), Google
  Calendar (indisponível).
- **Comparação importante:** o Assis usa o **WhatsApp Cloud API oficial**
  (Meta), enquanto o `aula-agente` usa **Evolution API** (gateway
  não-oficial/self-hosted). Isso é uma diferença arquitetural relevante,
  não só de feature — API oficial tem mais estabilidade e compliance mas
  exige verificação de Business/templates para mensagens frias; Evolution
  é mais flexível mas roda por fora dos termos oficiais do WhatsApp. Vale
  uma conversa à parte sobre se/quando migrar.

### 10. Configurações (`/settings`)
- Perfil pessoal (nome, e-mail — e-mail não editável, só suporte).
- Empresa: nome (usado quando a IA se apresenta) + descrição livre (até
  400 caracteres, usada como contexto — "inclua produtos, formas de
  pagamento, prazos e diferenciais").
- Simples, sem billing/equipe visível nesta tela (pode estar em outro
  lugar do menu do perfil, não explorado).

## Recomendação de prioridade (proposta, não decidida)

1. **Analytics básico** — pelo menos taxa de auto-resolução e motivos de
   handoff. É o argumento mais forte pra mostrar valor de trocar de
   ferramenta.
2. **Modelo de arquivos/skills no Trainer** — avaliar se vale evoluir o
   Trainer atual pra esse formato mais granular, ou se é over-engineering
   pro estágio atual.
3. **Artefatos** (geração de documento sob demanda) — feature
   diferenciada, mas sem sinal de que o cliente atual precisa disso ainda
   (Assis também não tem nenhum artefato criado na conta real).
4. **Campanhas/Rotinas** (outbound em massa, relatórios agendados) — baixa
   urgência, cliente atual não usa nem no Assis.
5. **Migração pra WhatsApp Cloud API oficial** — decisão arquitetural
   separada, não uma "feature" a portar; discutir custo/benefício à parte.

Este documento não substitui uma spec — antes de implementar qualquer item
acima, passar pelo processo normal de brainstorming/spec deste projeto.
