# Follow-up de proposta, promessas do vendedor e alertas urgentes — desenho

Data: 22/11/2026. Aprovado pelo dono (conversa de 22/11). Entrega: um PR com testes, **sem implantar** (nenhuma migração aplicada,
nenhuma flag ligada, quadro antigo mantido).

## Por que

Cliente interessado esfria enquanto ninguém percebe. Três buracos concretos:

1. O vendedor manda a proposta e só pergunta "o que achou?" um dia depois (o primeiro lembrete hoje é de 1 dia útil).
2. O vendedor promete "vou verificar e te retorno" e nada cobra essa promessa.
3. Clientes escapam do rodízio: o @lid que volta a escrever vira contato novo sem dono; o cliente que escreveu e não recebeu resposta
   nenhuma (nem da IA) não entra em fila de ninguém.

Objetivo do dono: **não aumentar a quantidade de alertas**; garantir que nenhum cliente interessado fique esquecido e nenhuma promessa
de retorno deixe de ser cumprida.

## Princípio central

Separar **cliente esperando a loja** (urgente) de **loja esperando o cliente** (follow-up). São situações diferentes, com
destaques diferentes. Se tudo piscar, nada chama atenção.

| Situação | Tipo | Onde aparece | Destaque |
|---|---|---|---|
| Cliente escreveu e o prazo de resposta do vendedor venceu (alerta de SLA) | Urgente | topo de "Cliente respondeu" | borda vermelha pulsando + "Urgente · esperando há X" |
| Ninguém respondeu o cliente (exceção do rodízio) | Urgente | topo de "Cliente respondeu" | idem |
| Vendedor prometeu retorno e o prazo da promessa venceu | Urgente | topo de "Cliente respondeu" | idem + "Retorno prometido vencido" |
| Proposta enviada, cliente sem responder (30 min, 1, 3, 7 dias) | Follow-up | "Compromissos de hoje" | selo âmbar fixo, **sem piscar** |

## Escopo

### 1. Calendário com feriados (Posse/GO)

- O calendário comercial passa a ter feriados. Conta minutos úteis só com a loja aberta e fora de feriado.
- Conjunto padrão `posse_go`, gerado por ano (função pura):
  - **Nacionais:** 01/01, Sexta-feira Santa (móvel, pela Páscoa), 21/04, 01/05, 07/09, 12/10, 02/11, 15/11, 20/11, 25/12.
  - **Estadual de Goiás:** 26/07, Fundação da Cidade de Goiás (Lei estadual 9.314/1983). Quando um decreto transfere a data
    (em 2026 foi para 20/07, Decreto 10.935/2026), vale o ajuste manual abaixo.
  - **Municipais de Posse:** 19/07 (Aniversário, Lei 110/1985), 26/07 (Padroeira N. Sra. Sant'Ana, Lei 110/1985) e
    19/10 (Monsenhor, Lei 1.283/2020).
  - **Fora:** pontos facultativos (Carnaval, Corpus Christi, vésperas) e o Dia do Servidor Público (28/10), que é só do serviço público.
    A data de 30/05, citada por um único site e sem lei, também fica fora até ser confirmada.
- Configurável em `business_calendar`: `holiday_set` ("posse_go" ou ausente), `extra_holidays` (datas a mais, por exemplo um decreto),
  `open_days` (datas de feriado em que a loja abre excepcionalmente). Sem `holiday_set`, nada muda.
- **Definição de "1 dia útil":** é a duração do dia comercial mais longo do calendário (600 minutos no padrão 08:00–18:00), contada
  só com a loja aberta. Isso não é "8 horas acumuladas". Proposta às 15:00 de sexta vence às 15:00 de segunda; se segunda for
  feriado, às 15:00 de terça.

### 2. Identificação de proposta (só com evidência forte)

Uma mensagem do vendedor (role `human_agent`, a última da conversa) é **proposta enviada** quando:

- **(a) Evento explícito:** existe `opportunity_events` `stage_changed` para uma etapa de proposta (`proposal_sent`,
  `simulation_sent`, `plan_term_presented`) do negócio aberto. O evento precisa estar entre 2 horas úteis antes da mensagem e o
  momento atual. Motivo gravado: "Etapa movida para Proposta enviada às HH:MM".
- **(b) Evidência comercial forte no conteúdo:**
  - texto (ou legenda) com **valor em dinheiro** (R$, "mil", número com separador de milhar) **e** pelo menos um termo
    comercial (parcela, entrada, crédito, proposta, simulação, financiamento, consórcio, lance, à vista, valor);
  - ou documento (PDF) cujo nome ou legenda contenha proposta, simulação ou orçamento.
- **Não contam sozinhos:** imagem (pode ser foto de moto), etapa "Negociação", anexo sem termo comercial, valor sem termo comercial.
- **Incerto:** sem lembrete de 30 minutos. Ficam só os de 1, 3 e 7 dias, como hoje.
- Cada proposta identificada grava o motivo e a evidência (auditoria).

### 3. Lembrete de 30 minutos (tarefa interna, nunca mensagem ao cliente)

- 30 minutos úteis depois da proposta identificada, se o cliente não respondeu e o vendedor não voltou a falar, nasce a tarefa
  interna `proposal_followup`: "Proposta enviada há 30 min — avaliar próximo contato." Para o dono do negócio.
- Nada é enviado ao cliente.
- A tarefa se encerra sozinha quando o vendedor manda nova mensagem, quando o cliente responde ou quando o negócio fecha.
- Depois dela seguem os degraus de 1, 3 e 7 dias do "Cutucar cliente" já existente (sem mudança de regra).
- Quando o cliente responde, a escada zera **e** a conversa passa na hora para "Cliente respondeu" (o card já faz isso pela última
  mensagem). As tarefas de follow-up abertas são encerradas com nota.

### 4. Promessa do vendedor = pendência interna com prazo

Mensagem do vendedor com promessa de retorno cria a tarefa `return_customer` "Retornar ao cliente". O prazo depende do tipo:

| Frase | Prazo |
|---|---|
| "já te falo", "só um instante", "um momento", "um minutinho", "já volto", "já te respondo" | 30 minutos úteis |
| "vou verificar", "vou consultar", "vou ver", "vou confirmar", "te retorno", "retorno em breve", "vou checar" | 2 horas úteis (ajustável: `promise_default_minutes`) |
| Horário explícito: "te retorno às 15h", "até as 16:30", "amanhã às 9h" | o horário informado (se já passou hoje, é o de amanhã útil) |
| "amanhã" sem horário | 2 horas úteis depois da abertura do próximo dia útil |

- Enquanto não vence: tarefa normal. Vencida: o card entra em **Urgente** até a pendência ser resolvida.
- **Uma nova mensagem genérica do vendedor NÃO encerra a promessa.** Encerra quando:
  - o vendedor conclui a tarefa no CRM;
  - uma mensagem posterior do vendedor traz evidência comercial forte (regra 2b), ou seja, ele entregou o que prometeu;
  - ou o negócio é ganho ou perdido.
- Nova promessa na mesma conversa atualiza o prazo da tarefa aberta, em vez de duplicar.

### 5. Clientes que escapam (automático, só eles)

- **@lid que volta a escrever:** quando o mesmo evento do WhatsApp traz o par identificador @lid + número real (`remoteJidAlt` /
  `sender_pn`, ou `chatlid` da UAZAPI quando o chat já vem com o número), o contato @lid antigo assume o número real. A conversa,
  o vendedor, o histórico e o negócio continuam. Se já existir outro contato com o número real, a função de banco
  `merge_wa_contact` move os registros do @lid para ele numa transação. Em qualquer conflito: desfaz tudo, registra o aviso e
  segue o fluxo antigo.
  - **Nunca** se junta por nome, foto ou semelhança. Só pelo par vindo do WhatsApp, com número de 10 a 15 dígitos que não seja o da
    própria loja.
- **Cliente sem resposta nenhuma:** quando a varredura de "lead sem resposta" decide avisar (nem IA nem humano responderam), a
  conversa não tem dono nem atribuição ativa, e a distribuição está ligada, o sistema cria o registro de encaminhamento
  (`trigger_type = 'sistema_sem_resposta'`, `criado_por = 'sistema'`) e chama `distribute_lead`, como faz a IA. Só dentro do
  horário comercial.
- Leads comuns continuam na regra atual: só ganham vendedor quando a IA pede um humano.

### 6. Funil

- Cards **Urgentes** vão para o topo de "Cliente respondeu", com borda vermelha pulsando (respeita `prefers-reduced-motion`), o selo
  "Urgente · esperando há X" e o motivo. A coluna mostra o contador vermelho de urgentes.
- Cards de **Follow-up** ficam em "Compromissos de hoje" com selo âmbar fixo "Follow-up · proposta sem resposta há X". Não piscam.
- O card para de piscar quando a causa some: o vendedor responde, a promessa é cumprida ou concluída, ou o alerta é resolvido.
- **O quadro "Atraso no atendimento" fica.** A urgência vem das mesmas consultas dele (`listSlaAlerts`, `listOpenExceptions`).
  A API informa quantos casos do quadro **não** têm card no funil (por exemplo, exceção sem negócio aberto). O quadro só pode sair
  quando esse número ficar zerado em produção por um período combinado. A retirada é outro PR.

### 7. Métricas de proposta

- Tabela `proposal_followups`: uma linha por proposta identificada. Guarda negócio, conversa, vendedor, mensagem, horário, motivo e
  evidência, a primeira nova mensagem do vendedor, a primeira resposta do cliente e o resultado do negócio.
- Indicadores por vendedor (Marina e Márcio) e por período:
  1. propostas realmente enviadas (identificadas);
  2. percentual acompanhado no prazo: novo contato do vendedor em até 30 minutos, 1 dia ou 3 dias úteis. O cliente que respondeu
     antes aparece separado ("cliente respondeu antes"), porque não precisou de acompanhamento;
  3. conversão: negócios ganhos.
- A tela diz explicitamente que é **correlação, não causa**: o tempo de acompanhamento sozinho não explica a venda.

### 8. Rotina e garantias técnicas

- Nova rotina `commitments` a cada **5 minutos**. Ela só lê as últimas mensagens de vendedor dos últimos 3 dias, o que é leve para o
  plano Nano. A rotina de 1, 3 e 7 dias continua a cada 30 minutos (no degrau de dias, 5 minutos não mudam nada).
- **Sem duplicados:** chave única por mensagem do vendedor (`proposal_followups.seller_message_id`, `metadata.source_message_id`
  na tarefa) e o `createTaskWithDedup` de sempre. Rodar duas vezes seguidas não cria nada novo.
- **Mensagem antiga que chega atrasada:** vale o horário original do WhatsApp (`metadata.wa_original_at`), quando existe. Mensagem
  com mais de 24 horas não gera promessa nem proposta nova (é histórico).
- **Reabertura:** conversa reaberta mantém o vendedor (regra já existente de herança). As tarefas se ligam ao negócio, não à conversa.
- Tudo atrás de flags, todas desligadas por padrão: `commitments_enabled`, `escape_distribution_enabled`, `lid_auto_merge_enabled`,
  `urgent_cards_enabled` e `business_calendar.holiday_set`.

## Fora do escopo

- Retirar o quadro "Atraso no atendimento" (outro PR, depois da prova de cobertura).
- Push no celular do vendedor para as novas tarefas (pode vir depois; a tela já sinaliza).
- Distribuir todo lead novo automaticamente (decisão do dono: só os que escapam).
- Consulta ativa à UAZAPI do número dos @lid antigos que não voltam a escrever.

## Testes obrigatórios (pedidos do dono)

1. Minutos úteis com horário comercial e feriados (inclusive Sexta-feira Santa, feriado em dia útil, `open_days`).
2. Mensagem antiga chegando atrasada não gera promessa nem proposta.
3. Reabertura de conversa preserva o vendedor e as tarefas do negócio.
4. Duas execuções seguidas da rotina de 5 minutos não criam lembretes repetidos.

## Fontes dos feriados

- TJGO, feriados municipais das comarcas: https://www.tjgo.jus.br/index.php/corregedoria-menusuperior/feriados
- TRT18, calendário de feriados locais: https://www.trt18.jus.br/portal/arquivos/2020/12/Calendario-Anual-2021-em-PDF-1.pdf
- Decreto estadual de 2026 que transfere o 26/07: https://legisla.casacivil.go.gov.br
- Confirmar no Diário Oficial de Posse antes de ligar.

## Decisões tomadas na implementação

1. **Janela do evento de etapa.** O evento de etapa vale se aconteceu até **2 horas de relógio** antes da mensagem (o texto acima
   dizia "2 horas úteis"). Na prática quase sempre dá o mesmo, porque o vendedor move a etapa e manda a proposta em seguida. Se
   estiver errado: uma proposta mandada logo na abertura, para uma etapa movida no fim do expediente anterior, não é reconhecida
   pelo evento (mas ainda pode ser pelo conteúdo).
2. **Uma proposta por conversa a cada 2 horas.** Etapa movida seguida de várias mensagens, ou proposta mandada em partes, conta uma
   vez só (a primeira mensagem). Se estiver errado: uma proposta revisada dentro de 2 horas não ganha lembrete de 30 min próprio; o
   cliente que sumir ainda cai no "Cutucar cliente" de 1, 3 e 7 dias.
3. **Leitura incremental.** A rotina de 5 minutos lê só as mensagens novas desde a última execução, com 10 minutos de folga. Depois
   de um reinício, relê as últimas 24 horas, sem duplicar nada graças às chaves únicas. Os degraus de 1, 3 e 7 dias continuam na
   rotina de 30 minutos. O motivo é a carga no banco (plano Nano).
4. **Promessas em tabela própria** (`seller_commitments`), porque a tabela de tarefas não tem metadados. Essa tabela evita
   duplicidade, serve de auditoria e define o "Urgente" sem depender do agrupamento de tarefas.
5. **Encerramento da pendência "Retornar ao cliente"** usa o encerramento por tipo de pendência que já existe. Numa tarefa agrupada,
   ele remove todas as pendências `return_customer` dela. Se estiver errado: um "Retornar cliente" criado pela IA no mesmo negócio
   fecharia junto quando a promessa é entregue.
6. **Cliente que escapou passa para o atendimento humano** (`is_human_takeover`), como no pedido de humano da IA, para que a IA não
   responda depois por cima do vendedor.
7. **@lid juntado que volta sem o número junto:** o webhook procura o contato que guardou aquele @lid (`metadata.lid`) em vez de
   criar um contato @lid novo.
8. **Selo de follow-up sem "há X".** O selo diz o tipo ("proposta sem resposta" ou "cliente sem responder") sem o tempo, porque o card
   não carrega o horário da proposta. O tempo aparece na tarefa.

## Revisão corretiva (pedido do dono, 22/11)

1. **A etapa movida depois não transforma mensagem anterior em proposta.** O evento de etapa vale para uma única mensagem: a
   primeira do vendedor depois do evento (evento até 2 h antes) ou a última antes dele (evento até 10 min depois), e só se não
   houver outra mensagem do vendedor no meio. Uma proposta com valor no mesmo intervalo prevalece sobre a identificada pela etapa,
   que é descartada se ainda não tiver lembrete. Isso substitui as decisões 1 e 2 da seção anterior.
2. **Clientes esquecidos com operação atômica.** A função `distribute_escaped_lead` grava o encaminhamento, chama o rodízio e liga
   o atendimento humano numa única transação. A IA só é desligada quando há vendedor atribuído.
   - Rodízio vazio: tudo é desfeito e nada fica gravado. A varredura não repete por 24 h.
   - Erro do rodízio: nada fica gravado e a varredura tenta de novo.
   - Exceção para o gestor: o encaminhamento e a exceção ficam, mas a IA continua ativa.

   Isso substitui a decisão 6.
3. **A cobertura prova que o caso aparece como Urgente na fila certa.** A rota monta os cards pelo mesmo pipeline do funil (visão
   do gestor, urgência aplicada como se a flag estivesse ligada) e confere `classifySalesQueue` = "Cliente respondeu". Cada caso
   descoberto vem com o motivo: `no_open_card`, `not_urgent` ou `wrong_queue`.
4. **Substituição de promessa.** O novo prazo troca a data, a hora e a prioridade da tarefa: a atualização genérica de tarefa
   semelhante não trocava a hora. Se a promessa antiga estava em outra tarefa, a pendência dela é encerrada.
