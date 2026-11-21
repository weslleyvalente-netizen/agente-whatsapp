# Evolution + ajuste do Baileys (ack do `<status>`): roteiro de teste e troca

**Status: hipótese em teste. Nada foi construído nem implantado** (não há Docker na máquina de desenvolvimento).

## O que está verificado e o que não está
Verificado:
- Baileys **#2858** é real: `<status>` não confirmado → o servidor derruba o stream ~50 min depois da conexão (`Stream Errored (ack)`, `class="status"`),
  e o mesmo `<status>` volta como pendente na reconexão. Confirmado sem handler em `7.0.0-rc.9`, `rc14` e `master`; Evolution 2.3.7 usa `rc.9`.
  Relatos de melhora (24 h a 27 h sem o erro) são de casos individuais, **sem comparação controlada**; várias contas nunca tiveram o defeito.
  Um relato descreve, depois de uma reconexão, o socket "aberto" sem entregar mensagens por 16 min até reiniciar (parecido com o nosso).
- No pacote `baileys@7.0.0-rc.9` real (npm): sem `CB:status` em `socket.js` e `messages-recv.js`; `sendMessageAck` existe em `messages-recv.js`.
  O patch tem **1** ponto de inserção e a sintaxe ESM passa em `node --check`.
- No Evolution Manager esta instância mostra todas as chaves desligadas e o processo não reiniciou entre as últimas quedas (não é memória).
- Dois intervalos locais: o "última sessão ativa" do aparelho CRM parou 3h19 (06:48) e 3h12 (14:43) antes de o CRM parar de receber (10:07 e 17:55, Brasília).

**Não verificado:** que o nosso defeito é esse. Ainda falta achar nos logs do Evolution a assinatura (`Stream Errored (ack)` com `class="status"`) numa falha
local. Os nossos intervalos (~3 h) não são os de ~50 min do relato; o ajuste só vale a troca se o teste controlado reproduzir o defeito.
Também não foi comparado o ajuste direto (este) com o do PR **Baileys #2883** (aberto, não mesclado), que passa o `<status>` por `processNode` e inclui
a fila offline em ordem. Este patch confirma cada `<status>` assim que chega (online e offline), sem ordenação; se após ele a conta de teste ainda ficar
"aberta mas surda", testar a variante do #2883 (sem decodificar o status), um passo por vez.

## O que o patch faz
Antes do handler `CB:ack,class:message`, acrescenta:
`ws.on('CB:status', (node) => { sendMessageAck(node).catch((e) => onUnexpectedError(e, 'acking status stanza')); });`
O build falha se: arquitetura diferente de amd64; não houver exatamente 1 `messages-recv.js`; existir outra cópia do código do Baileys na aplicação;
versão do Baileys ≠ 7.0.0-rc.9; já existir `CB:status`; o ponto de inserção não aparecer exatamente uma vez; o patch não ficar aplicado; ou a sintaxe
ficar inválida. Depois do build, confirmar no Console do serviço: `grep -c "CB:status" <caminho do messages-recv.js>` = 1.
**Ainda falta** ensaiar o ack emitido para `<status>` online e offline em uma conta real (item 2 abaixo).

## 0. Antes de qualquer coisa
1. Backup do Postgres do Evolution (`evolution-db`). A sessão do WhatsApp (instância, credenciais) fica nesse banco e no cache Redis do serviço;
   preservar volumes, variáveis de ambiente e a `AUTHENTICATION_API_KEY` ao trocar a Fonte.
2. Registrar o **digest da imagem em execução** hoje e usá-lo no rollback (não a tag): a tag `v2.3.7` está fixada no Dockerfile ao digest
   `sha256:456b4104…dfc81` (amd64, Docker Hub, atualizada em 2025-12-05). Confirmar `uname -m` = `x86_64` no Console do `evolution`.
3. O PR do monitor (#92) deve estar no ar com `evolution_monitor_enabled` ligado: dá o horário das quedas e a última desconexão/código.
4. Procurar nos logs a assinatura `Stream Errored (ack)` e `class="status"` (o visualizador do EasyPanel fica preso; reiniciar o serviço o atualiza).

## 1. Teste isolado e CONTROLADO (não toca a produção)
Um número não pode estar em dois Evolution ao mesmo tempo. Montar:
- Serviço(s) novo(s) no EasyPanel, **banco e Redis próprios e vazios**, `AUTHENTICATION_API_KEY` diferente, domínio/acesso restrito (sem exposição pública da API),
  **webhook exclusivo** apontando para um receptor de teste (ou desligado): nunca para o CRM, filas ou agentes reais.
- **Número dedicado**, sem uso operacional (o chip do Pós-venda só se estiver livre; se o aparelho for o mesmo celular da loja, não serve). Se possível, 2 contas.
- Sondas: mensagens de teste a cada 30 min, com horário registrado dos dois lados (envio e chegada ao Evolution de teste), por **pelo menos 24 h**
  (as nossas falhas apareceram entre 6 e 20 h; cobrir a janela de ~3 h do "última sessão ativa" do aparelho).

Procedimento:
1. **Controle primeiro:** rodar a imagem ORIGINAL (`evoapicloud/evolution-api:v2.3.7@sha256:456b4104…`) com a conta de teste até **reproduzir o defeito**
   (reconexão a cada ~50 min e/ou surdez) e confirmar a assinatura no log. **Se o controle não reproduzir, o teste do patch é inconclusivo** (várias contas
   nunca falham): trocar de conta/aparelho ou parar aqui; 24 h sem falha com o patch não provam nada nesse caso.
2. Depois, a imagem corrigida, nas mesmas condições (mesmo número, mesma duração, mesmas sondas). Comparar: reconexões, `Stream Errored (ack)`,
   mensagens recebidas, "última sessão ativa" do aparelho.
3. Ensaiar o **ack de `<status>` online e offline**: com a conta de teste, publicar um status em outro aparelho e conferir o ack no log (online); derrubar a conexão por
   alguns minutos com um status pendente e conferir o ack quando voltar (offline).
4. Ensaiar o **rollback no serviço isolado**: voltar à imagem original pelo digest, preservando volumes, e anotar o que acontece com a sessão (se pedir QR, refazer e medir).
5. Se a conta de teste ainda ficar "aberta mas surda" com o patch, testar a variante do #2883 (um passo por vez); se também falhar, a hipótese cai e o plano B é a UAZAPI.

## 1b. Sem número reserva: medir no próprio 9050
Se não houver número de teste, o 9050 faz o papel do controle: as quedas já ocorrem nele (5 em 6 dias).
1. Com o monitor (#92) ligado e a imagem ORIGINAL, medir por **2 a 3 dias**, com mensagens de teste em horários registrados e correlação com os logs
   (reconexões, código da última desconexão, `Stream Errored (ack)` com `class="status"`). Um código 500 é só uma pista; a evidência específica é a assinatura no log.
2. **Se a falha não aparecer nesse período, a medição é inconclusiva** (não autoriza a troca nem a descarta).
3. Só depois decidir a troca de imagem, separadamente, com o digest de rollback conferido; comparar as quedas por dia antes e depois.
O monitor é consulta a cada 5 min e só vê a última desconexão: serve para localizar e comparar, não para contar cada queda.

## 2. Troca em produção (só se o teste isolado reproduzir o defeito no controle e passar com o patch)
- **Fora do horário comercial.** Indisponibilidade estimada de 1 a 2 min e continuidade da sessão (sem novo QR) são **estimativas**, não garantias: ensaiar antes (item 1.4).
- EasyPanel > `evolution` > Fonte: trocar **Imagem Docker** por **Dockerfile** (este conteúdo, com o digest) e Implantar.
- **Risco após a troca:** o WhatsApp pode entregar em lote mensagens antigas represadas. O CRM ignora duplicatas pelo `evolution_message_id` (índice único), mas a IA
  pode responder mensagens velhas: fazer a troca com a fila vazia e acompanhar as primeiras respostas da IA nas conversas recebidas no lote.
- Verificar: `connectionState` = open; mensagem de teste chega ao CRM; `grep -c "CB:status"` = 1 no Console.
- Observar **pelo menos 24 h** com sondas (não só 2 h: 2 h servem só para checar a troca inicial).

### Gatilhos de reversão (qualquer um)
- **Recebimento:** uma mensagem de teste, mandada de outro aparelho e **confirmada no celular da loja**, que não chega ao Evolution nem ao CRM em alguns minutos
  (30 min sem tráfego espontâneo podem ser só um período sem mensagens: não usar isso sozinho como gatilho);
- falha de envio pelo CRM ou erros do webhook para a API;
- `connectionState` diferente de `open` por mais de 5 min, ou reconexões repetidas;
- duplicatas ou respostas automáticas em massa a mensagens antigas.

## 3. Volta (rollback)
EasyPanel > `evolution` > Fonte: **Imagem Docker** `evoapicloud/evolution-api:v2.3.7@sha256:456b4104b0ddffbb092d6b3c0560a4ae86fc3e014e885b882aca4b1b371dfc81`
(ou o digest registrado do contêiner em execução, se for outro) e Implantar. Banco e volumes não mudam. Se a sessão cair na volta, ler o QR de novo.

## Não fazer
- Não rodar o Evolution de teste com o mesmo banco/Redis/número/webhook da produção.
- Não mexer em `Always Online`, nível de log ou webhook como parte desta troca (uma variável por vez).
