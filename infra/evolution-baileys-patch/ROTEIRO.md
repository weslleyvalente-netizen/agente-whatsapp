# Evolution + ajuste do Baileys (ack do `<status>`): roteiro de teste e troca

**Status: hipótese em teste, não implantado.** Nada aqui foi construído como imagem (não há Docker na máquina de desenvolvimento).
O que foi verificado: no pacote `baileys@7.0.0-rc.9` (a versão que o Evolution 2.3.7 declara no `package.json`) **não existe handler `CB:status`**
em `lib/Socket/socket.js` nem em `messages-recv.js`, e `sendMessageAck` existe em `messages-recv.js` (usado nas notificações). A única linha
do patch foi aplicada ao arquivo real extraído do npm: houve **exatamente 1** ponto de inserção e a sintaxe ESM passou em `node --check`.
**Não está provado** que isso cura a surdez; as issues citadas (Baileys #2858 / Evolution #2778) não foram localizadas nas buscas.

## Por que testar (evidência do nosso caso)
- Sessão "open" que deixa de receber enquanto o envio continua; reiniciar o serviço não resolve, só ler o QR de novo.
- 5 quedas em 6 dias. Processo do Evolution sem reinício entre as últimas quedas (não é memória).
- **Padrão no celular (2 observações):** "última sessão ativa" do aparelho CRM parou **3h19 (06:48) e 3h12 (14:43) antes** de o CRM parar de receber
  (10:07 e 17:55, horário de Brasília). Sugere que a sessão deixa de ser considerada ativa e o WhatsApp para de entregar ~3 h depois.
  Com o ajuste, esperamos que o "ativa hoje às …" continue acompanhando o horário atual.

## O que o patch faz
Acrescenta, antes do handler `CB:ack,class:message`:
`ws.on('CB:status', (node) => { sendMessageAck(node).catch((e) => onUnexpectedError(e, 'acking status stanza')); });`
O build **falha** se: o arquivo não for encontrado, a versão do Baileys não for 7.0.0-rc.9, já existir `CB:status`, o ponto de inserção não aparecer exatamente uma vez, ou o patch não ficar aplicado.

## 0. Antes de qualquer coisa
1. Backup do Postgres do Evolution (`evolution-db`) e anotar o digest da imagem atual (Docker Hub, `evoapicloud/evolution-api` tag `v2.3.7`).
2. Trocar `FROM` para `...:v2.3.7@sha256:<DIGEST>` (fixa a versão-base).
3. Ligar `evolution_monitor_enabled` depois que o PR do monitor (#92) estiver no ar: fornece o horário exato das quedas.

## 1. Teste isolado (não mexe na produção)
Uma instância do Evolution **não pode** rodar em dois lugares com o mesmo número (um derruba o outro). Por isso:
1. No EasyPanel, criar um serviço novo `evolution-patch` com **Fonte > Dockerfile** (colar o `Dockerfile` desta pasta), **banco e Redis próprios/vazios**,
   outra `AUTHENTICATION_API_KEY` e domínio próprio. Não reutilizar `evolution-db` nem o Redis do CRM.
2. Conectar por QR um **número de teste** (ex.: o chip do Pós-venda), nunca o da loja.
3. Conferir no Console do serviço: `grep -c "CB:status" $(find / -xdev -path '*/node_modules/baileys/lib/Socket/messages-recv.js' | head -1)` deve dar `1`.
4. Observar por **pelo menos 24 h** (a queda aparecia em 6 a 20 h; vale cobrir a janela de ~3 h do "última sessão ativa"):
   - celular: "última sessão ativa" do aparelho segue o horário atual;
   - mandar mensagens de teste a cada algumas horas e conferir que chegam ao Evolution de teste.
5. Se parar de receber de novo, a hipótese está descartada: apagar o serviço de teste e seguir para o plano B (UAZAPI).

## 2. Troca em produção (só se o teste passar), fora do horário comercial
1. Anunciar a janela (1 a 2 min de envio/recebimento parado). A recuperação automática do CRM cobre o intervalo se o WhatsApp entregar depois.
2. EasyPanel > `evolution` > Fonte: trocar **Imagem Docker** por **Dockerfile** (mesmo conteúdo, com o digest) e Implantar.
3. A sessão e os dados ficam no `evolution-db`: é a mesma versão do Evolution, só com uma linha a mais no Baileys. Não precisa refazer o QR.
4. Verificar: `connectionState` = open; mensagem de teste chega ao CRM; `grep -c "CB:status"` = 1 no console.
5. Acompanhar 2 h com testes e olhar o monitor (#92).

## 3. Volta (rollback)
EasyPanel > `evolution` > Fonte: voltar para **Imagem Docker** `evoapicloud/evolution-api:v2.3.7` e Implantar. Os dados não mudam; se a sessão
cair na troca, ler o QR de novo (processo conhecido).

## Não fazer
- Não rodar o Evolution de teste com o mesmo banco/Redis/número da produção.
- Não mudar `Always Online`, nível de log ou webhook como parte desta troca (testar uma variável por vez).
