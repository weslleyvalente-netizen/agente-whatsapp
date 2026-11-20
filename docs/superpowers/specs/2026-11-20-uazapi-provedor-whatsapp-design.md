# UAZAPI como provedor de WhatsApp ao lado da Evolution (chave por instância)

Data: 20/11/2026. Status: aprovado pelo dono em 20/11, com virada direta (opção B, sem fase de sombra).

Servidor UAZAPI do dono: `https://motoetrilha.uazapi.com` (valor de `UAZAPI_BASE_URL`). Plano (pago ou teste) a confirmar.

## Por que

A Evolution 2.3.7 (Baileys rc) ficou "surda" pela 5ª vez em 19/11 às 20:10: informa conexão `open`, mas não recebe nenhuma
mensagem do WhatsApp. Ela mesma não grava nada (a `last_evolution_message_at` do monitor parou no mesmo segundo que o CRM), então o
problema é entre o WhatsApp e a Evolution, não no nosso webhook. Cada queda faz perder leads da campanha até alguém perceber e ler
o QR de novo. O dono decidiu adotar a UAZAPI (serviço hospedado, API própria) e escolheu a opção A: **UAZAPI ao lado da
Evolution, escolhida por instância, com volta rápida**.

## Objetivos

1. Receber, gravar e processar mensagens de clientes vindas da UAZAPI exatamente como hoje com a Evolution: IA, encaminhamento,
   distribuição, ecos do celular da loja (fromMe), status de entrega/leitura, mídia (áudio, imagem, documento, vídeo), anúncio
   Click-to-WhatsApp, `@lid` com o número real, contatos ignorados, guarda de mensagem atrasada.
2. Enviar pela UAZAPI tudo o que hoje sai pela Evolution: texto (IA, painel, follow-ups, varredor), mídia, áudio de voz (PTT).
3. Monitor de conexão, alerta de conexão muda e recuperação automática funcionando com a UAZAPI.
4. Trocar o provedor de uma instância é uma mudança de configuração (sem deploy); voltar para a Evolution também.

## Fora do escopo (não-objetivos)

- Remover a Evolution ou seu código. Ela continua como reserva.
- API oficial da Meta (Cloud API).
- Grupos, status/stories, newsletters, chamadas (continuam ignorados, como hoje).
- Criar a conta UAZAPI: é contratação do dono. Ele fornece a URL do servidor e o token de administrador (colados no EasyPanel;
  nunca digitados por mim).

## Anti-objetivos (falha mesmo que "funcione")

- Perder mensagem de cliente na virada (ou em silêncio, sem alerta).
- Duas fontes gravando a mesma mensagem duas vezes (Evolution e UAZAPI ligadas no mesmo número).
- Responder duas vezes ao cliente (IA disparada pelos dois provedores).
- Aceitar webhook forjado: a UAZAPI não assina o webhook.
- Mexer no comportamento de SLA/distribuição/IA.

## Abordagens consideradas

| | Como | Troca |
|---|---|---|
| **1. Tradução na entrada + interface de saída (escolhida)** | Nova rota `/webhooks/uazapi` converte o evento da UAZAPI no formato interno que o handler da Evolution já valida (`evolutionWebhookPayloadSchema`) e chama a MESMA lógica. Na saída, uma interface `WhatsAppProvider` (texto, mídia, áudio, baixar mídia, foto, estado, buscar mensagens) com duas implementações, escolhida pela instância. | Reaproveita as ~785 linhas do handler e seus 15 arquivos de teste (ecos, corrida de eco, `@lid`, anúncio, guarda de atraso, contato ignorado). O formato interno continua com nomes da Evolution (`evolution_message_id`, `remoteJid`): feio, mas estável. |
| 2. Modelo neutro do zero | Reescrever o handler sobre um tipo "mensagem de WhatsApp" neutro e adaptar os dois provedores a ele. | Mais limpo, porém reescreve a parte mais testada e frágil do sistema durante uma crise. Risco alto, prazo longo. |
| 3. Proxy fora do CRM | Serviço intermediário que imita a API da Evolution na frente da UAZAPI. | Zero mudança no CRM, mas é mais um serviço para manter, com a mesma tradução escondida e sem testes junto do código. |

A abordagem 1 foi escolhida por manter intacta a lógica que já sobreviveu a dezenas de incidentes e limitar o código novo a
tradução e transporte.

## Desenho

### Configuração por instância

- `evolution_instances` ganha `provider text NOT NULL DEFAULT 'evolution' CHECK (provider IN ('evolution','uazapi'))` e
  `provider_token_encrypted text` (token da instância UAZAPI, cifrado com o mesmo esquema de `packages/database/src/crypto`).
- Variáveis no EasyPanel (api e worker): `UAZAPI_BASE_URL`, `UAZAPI_ADMIN_TOKEN`. Sem elas, a UAZAPI fica indisponível e nada muda.
- O nome da instância continua sendo o elo (`instance_name`). Nada de apagar/recriar a linha (o `ON DELETE CASCADE` das conversas).

### Entrada: `/webhooks/uazapi`

1. **Autenticação**: o evento traz `token` (token da instância). A rota busca a instância pelo `instanceName`/`owner`, decifra o
   token guardado e compara em tempo constante. Diferente = 401. Também exige um segredo na URL (`?key=WEBHOOK_SECRET`, como a
   Evolution já usa), porque a UAZAPI não assina.
2. **Tradução** (`packages/shared/src/uazapi/translate.ts`, função pura e testada):
   - `messages` → `{ event: "messages.upsert", instance, data: { key: { remoteJid, remoteJidAlt, fromMe, id: messageid }, message, messageType, pushName: senderName, messageTimestamp: segundos, contextInfo } }`.
     - `remoteJid` = `chatid`; quando for `@lid`, `remoteJidAlt` = `sender_pn` (número real), que é o que o handler já sabe usar.
     - `messageTimestamp` da UAZAPI vem em **milissegundos**; converter para segundos.
     - Tipos: texto → `conversation`; imagem/áudio/vídeo/documento/figurinha/localização → os `*Message` equivalentes com legenda,
       segundos do áudio e nome do arquivo tirados de `content`; reação e mensagem apagada → `reactionMessage`/`protocolMessage`
       (o handler já ignora). Tipo desconhecido → passa adiante com o tipo original (o handler grava o marcador de "não suportada").
     - Anúncio: o `contextInfo.externalAdReply` que vier dentro de `content` é levado para `contextInfo`.
   - `messages_update` (`ReadReceipt`) → um evento de status por `MessageIDs[i]`, no formato que `parseEvolutionStatusUpdate` lê.
     `Timestamp` vem em **segundos**.
   - `connection` → grava uma observação de conexão (alimenta o monitor); não passa pelo handler de mensagens.
   - Grupos (`isGroup`), `history`, `status_posts`, `call` etc. → 200 e ignorado.
3. **Reuso**: o corpo atual do `POST /webhooks/evolution` vira uma função `handleInboundEvent(payload, ctx)`; as duas rotas a
   chamam. A rota da Evolution não muda de comportamento.
4. **Mensagens enviadas pela própria API** chegam como `fromMe` com `wasSentByApi: true`. Hoje o handler casa o eco com a mensagem
   pendente (corrida de eco). Mantemos esse caminho (não usamos `excludeMessages`), para o eco preencher o id do WhatsApp quando a
   resposta do envio se perder.

### Saída: interface `WhatsAppProvider`

Interface única (em `packages/agent-runtime` ou um pacote `packages/whatsapp`, a decidir na implementação) com:
`sendText`, `sendMedia`, `sendVoice`, `downloadMedia` (base64 + mimetype, com limite de bytes), `profilePictureUrl`,
`connectionState`, `latestReceivedAt`, `findMessages(chat, desde)`.

- Implementação Evolution = o código de hoje, só movido para trás da interface (mesmos endpoints, mesmo tratamento de erro).
- Implementação UAZAPI: `POST /send/text`, `POST /send/media` (`type` = image/video/document/ptt...), `POST /message/download`
  (devolve `fileURL` que expira em 2 dias; baixamos na hora para base64, respeitando o limite atual de mídia), `POST /chat/avatar`,
  `GET /instance/status`, `POST /message/find`. O id do WhatsApp da resposta (`messageid`) é o que vai para
  `evolution_message_id`.
- Todos os pontos que hoje fazem `fetch` direto na Evolution passam pela interface: `evolution.service.ts`,
  `workers/send-message.ts`, `unanswered-lead-sweep.ts`, `lib/profile-picture.ts`, `lib/image-description.ts`,
  `agent-runtime/audio-transcription.ts` (`fetchMediaBase64`), monitor e recuperação automática.
- Limite da UAZAPI: 10 chamadas/s por instância (429 com `Retry-After`): o envio respeita o `Retry-After` uma vez e depois falha
  como hoje falha um envio (marca `send_failed_at`).

### Reenvio limitado do webhook: reconciliação

A UAZAPI tenta reenviar um webhook que falhou algumas vezes (o exemplo de `GET /webhook/errors` mostra `attempts: 3`; a política
exata não está documentada), guarda falhas só por 24 h e desliga o webhook após 24 h sem entrega boa e 10+ falhas. Ela guarda as
mensagens para consulta por até 7 dias (`/docs/message-history-retention`), então a recuperação precisa rodar dentro desse prazo.
Não há cabeçalho customizado no webhook: o segredo vai na URL (`?key=`). A recuperação automática que já existe
(`auto-recover`, `recover-messages`) passa a usar `findMessages` do provedor da instância. O monitor também lê `GET /webhook`
(`health.status`) e trata `failing`/`disabled` como alerta.

### Virada direta (opção B, escolhida pelo dono em 20/11)

O WhatsApp aceita até 4 aparelhos conectados no mesmo número. A UAZAPI é conectada como **mais um aparelho** sem desconectar a
Evolution. Não há fase de sombra: assim que a UAZAPI estiver conectada e o código no ar, a instância passa para `'uazapi'`.

1. **Virada**: `provider = 'uazapi'`. A partir daí só a rota da UAZAPI grava; a da Evolution responde 200 e ignora mensagens da
   instância (evita gravação dupla). A deduplicação por `evolution_message_id` que já existe é a segunda trava.
2. **Conferência logo após a virada**: o dono manda do próprio celular texto, áudio, imagem e documento para o número da loja e um
   colega clica num anúncio; eu confiro no banco que cada um entrou com o tipo certo, que a IA respondeu uma vez e que o envio saiu
   pela UAZAPI. Falhou algo grave → volta.
3. **Volta**: `provider = 'evolution'` (mudança de configuração, sem deploy). Mensagens do intervalo são recuperadas pelo
   `findMessages` do outro provedor.
4. **Forma dos eventos**: como não há sombra, o webhook da UAZAPI registra em log, por evento, só a FORMA do payload (chaves e
   tipos, sem valores), o tipo de mensagem e se a tradução reconheceu o tipo. Isso substitui a captura da sombra para ajustar a
   tradução de mídia e anúncio depois da virada.

O dono precisa do celular só para conectar o aparelho novo (QR ou código de pareamento).

### Tela de Configurações

Mostrar o provedor da instância e, para a UAZAPI, o QR/código de pareamento (`/instance/connect`) e o estado. Trocar o provedor
fica restrito a administrador, com confirmação.

## Restrições

- Webhook responde 2xx rápido (o handler já é rápido; o trabalho pesado vai para a fila).
- Nada de conteúdo de mensagem, telefone ou token em logs e nas tabelas de evidência.
- Token da instância só no banco, cifrado; token de administrador só em variável de ambiente.
- Migrações no SQL Editor pelo dono/eu com autorização, como sempre; deploy pelo push na `main`.

## Testes

- `translate.ts`: um teste por tipo de evento/mensagem, com os exemplos da documentação e, depois da virada, com as formas
  registradas em log (valores fictícios). Casos: texto, áudio (segundos), imagem com legenda, documento, anúncio, `@lid` com `sender_pn`,
  `fromMe` do celular, `fromMe` `wasSentByApi`, reação, apagada, grupo, timestamp em ms.
- Rota `/webhooks/uazapi`: token errado → 401; instância em `'evolution'` → 200 e ignora; em `'uazapi'` → mesmo resultado que o teste
  equivalente da Evolution (rodar a bateria atual do handler pelas duas rotas onde fizer sentido).
- Interface de saída: cada implementação contra um servidor falso (como os testes atuais fazem com `fetch`).
- Rota da Evolution ignora instância em `'uazapi'`.

## Riscos e pontos em aberto

- **Formato de `content` por tipo de mídia não está documentado** (só "específico do tipo"). Mitigação: a tradução tem fallback para
  "mensagem não suportada" sem perder o registro; a forma dos eventos fica em log e a conferência logo após a virada testa cada tipo.
- **Anúncio Click-to-WhatsApp**: não sabemos se a UAZAPI repassa `externalAdReply`. Se não repassar, a origem do lead por anúncio
  piora. Verificar na conferência logo após a virada com um clique real no anúncio.
- **`/message/download` aceita `messageid` ou o `id` interno?** A documentação é ambígua; a implementação tenta `messageid` e, se falhar, o `id` interno; conferir na virada.
- **Retenção**: até 7 dias (pode ser menos com volume alto). A recuperação depois de uma queda longa precisa rodar nesse prazo.
- **Documentação conferida em 20/11** (docs.uazapi.com, uazapiGO v3.0.0): o `content` de mídia não tem chaves documentadas,
  `externalAdReply`/anúncio não aparece em lugar nenhum, preço/planos/auto-hospedagem não estão publicados. Os três só se resolvem
  com eventos reais (conferência pós-virada) e com a contratação.
- **Também é WhatsApp não oficial**: pode cair. A chave por instância e o monitor existem para isso.
- **Conta**: plano, preço e limites a confirmar pelo dono antes da virada.

## Decisões complementares (revisão do construtor; decisões minhas, marcadas para o dono conferir)

1. **A Evolution continua conectada como reserva depois da virada** (2º aparelho). Os monitores (`evolution-monitor.ts`,
   alerta de conexão muda e `health-monitor.ts`) passam a saber o provedor ativo de cada instância: alertam pelo ATIVO e só
   registram o estado da reserva. Os avisos de WhatsApp do `health-monitor` saem pelo provedor ativo. A rota da Evolution ignora
   mensagens, status e eventos de conexão de instância em `'uazapi'` (responde 200).
2. **A recuperação lê os dois provedores conectados** e junta pelo id do WhatsApp (sem duplicar). É o que cobre o caso de hoje: um
   provedor surdo também não tem as mensagens no próprio histórico. A regravação passa a chamar `handleInboundEvent` diretamente
   (não mais `app.inject` em `/webhooks/evolution`).
3. **Forma sem conteúdo em log** (no lugar da sombra, por causa da opção B): para cada evento, só a FORMA (chaves e tipos, sem
   valores), o tipo de mensagem, se a tradução reconheceu e quais campos vieram (ex.: `sender_pn`, `externalAdReply`).
4. **O CRM cria a instância na UAZAPI** com o token de administrador (`/instance/create`, mesmo nome da instância do CRM),
   guarda o token devolvido cifrado em `provider_token_encrypted` e registra o webhook (`/webhook`, eventos `messages`,
   `messages_update`, `connection`, URL com `?key=`). Ninguém copia token. A instância é achada pelo mesmo `instance_id`/nome.
5. **Autorização**: o dono pediu em 20/11 para implementar; cada PR e cada migração seguem com autorização explícita antes de
   produção.

## O que fica para quem implementar

Nome e lugar do pacote da interface, estrutura de arquivos da tradução, ajustes na tela de Configurações, e a divisão em PRs
(sugestão, pela pressa da queda: 1) migração + tradução + rota de entrada + saída UAZAPI + troca de provedor + botão mínimo em
Configurações para criar/conectar a instância UAZAPI (QR ou código), o mínimo para receber e responder; 2) monitor/alerta/
recuperação cientes do provedor; 3) acabamento da tela de Configurações).
