# Como capturar os logs da Evolution (sem reiniciar, sem mudar nada) — roteiro para a próxima ocorrência

## Por que é preciso
O stdout da Evolution é um pipe lido pelo Docker; o console do EasyPanel não o alcança e o visualizador de logs do EasyPanel não avança (17/11: último da Evolution = 13/11; da API = 15/11). Sem os logs do Baileys (erros de socket, decriptação, "Stream Errored", sincronização) a causa raiz não se prova. Os logs só estão no **host Docker**.

## Pré-requisitos (nenhum exige reiniciar ou alterar a Evolution)
- Acesso SSH ao servidor do EasyPanel (host 187.77.226.182) com um usuário que possa ler o Docker: `root` **ou** membro do grupo `docker`. Quem tem a chave SSH é o dono/administrador do servidor (a ser confirmado: não verifiquei quem tem acesso).
- Espaço em disco para salvar os arquivos fora do diretório do Docker.
- O serviço Swarm chama-se `agente-whatsapp_evolution` (o console mostrou a tarefa `agente-whatsapp_evolution.1.<id>`).

## Passo 0 — ao notar a surdez (ANTES de reconectar por QR)
1. Anotar a hora local do início e do aviso. Não clicar em Disconnect/Restart/QR. Um logout ("Log out instance") apaga o contexto da sessão surda.
2. Foto da tela do celular: Aparelhos conectados → "Última atividade" (a hora que o aparelho mostra).
3. Rodar os passos abaixo (levam poucos minutos). Só depois reconectar.

## Passo 1 — inspeção (somente leitura)
```bash
docker service ls | grep evolution
docker service ps agente-whatsapp_evolution --no-trunc          # tarefas atuais e anteriores (reinícios)
docker info --format 'driver padrão: {{.LoggingDriver}}'
docker service inspect agente-whatsapp_evolution --format '{{json .Spec.TaskTemplate.LogDriver}}'
CID=$(docker ps -q --filter name=agente-whatsapp_evolution | head -1)
docker inspect "$CID" --format 'driver: {{.HostConfig.LogConfig.Type}} cfg: {{.HostConfig.LogConfig.Config}} arquivo: {{.LogPath}}'
ls -la "$(docker inspect "$CID" --format '{{.LogPath}}')"*      # tamanho/rotação (json-file: max-size/max-file)
```
Se o driver for `json-file` ou `local`, `docker logs` funciona. Se `none`, não há logs (nesse caso a única saída é a mudança de driver, que **exige autorização**). Se houver rotação pequena, os dias antigos já se perderam: salvar logo.

## Passo 2 — captura e preservação (somente leitura)
```bash
D=evidencia-evolution-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p ~/$D && cd ~/$D
docker service logs --timestamps --since 12h agente-whatsapp_evolution > evolution-servico.log 2>&1
docker logs --timestamps --since 12h "$CID" > evolution-container.log 2>&1
grep -c "Stream Errored" evolution-*.log; grep -n -i -E "stream errored|status|ack|bad mac|no session|decrypt|connection (closed|lost)|logged out|Log out|restart required|timed out" evolution-servico.log | head -200 > achados.txt
sha256sum * > SHA256SUMS && chmod 600 *
```
- Preferir `--since` pequeno e específico (ex.: `--since 2026-11-17T12:00:00Z --until 2026-11-17T19:00:00Z`) quando a rotação for curta; se der para, salvar o arquivo inteiro do `LogPath` (`cp` para a pasta acima).
- Copiar a pasta para fora do servidor (`scp`), guardar o `SHA256SUMS` junto e não editar os originais.
- **Nunca** usar: `docker restart`, `docker service update/rm`, `docker system prune`, `docker rm`, nem mexer no volume do Evolution. `docker logs -f` também é leitura, mas não é necessário.
- Segredos: os logs podem conter URLs com `apikey=`. Mascarar (`sed -E 's/(apikey=)[^& ]+/\1***/g'`) **numa cópia** antes de compartilhar.

## Passo 3 — banco interno da Evolution (somente leitura, pelo Console do serviço no EasyPanel)
Usa a variável `DATABASE_CONNECTION_URI` do próprio contêiner (não imprimir). Sempre com `set default_transaction_read_only=on`. Consultas úteis (cole no console `sh` como `node -e '...'`, como nas investigações de 17/11):
- Entradas por hora e direção: `select to_char(to_timestamp("messageTimestamp") at time zone 'UTC','MM-DD HH24') h, "key"->>'fromMe' fm, count(*) from "Message" where "messageTimestamp" > extract(epoch from now()-interval '18 hours') group by 1,2 order by 1,2`
- **Quando cada mensagem foi realmente inserida** (o `id` é um cuid com o horário em base36): `parseInt(id.slice(1,9),36)` → comparar com `messageTimestamp`. Atraso grande = mensagem chegou em backlog; atraso ~0 = tempo real. Isso mostrou em 17/11 que tudo após 12:46 só entrou às 15:10 (depois do QR).
- Recibos das mensagens enviadas (`MessageUpdate` por `keyId`) no período mudo.
- Linha da instância: `select "connectionStatus","disconnectionAt","disconnectionReasonCode","disconnectionObject" from "Instance"` (`disconnectionObject` traz "Log out instance" quando o logout foi acionado na Evolution).

## Passo 4 — CRM (somente leitura)
Exportar `evolution_connection_observations` do dia (estado/última recebida a cada 5 min) e as `silent_connection_alerts` (se o PR #104 estiver ativo).

## Para não depender disso nas próximas vezes (exige autorização; não feito)
- Encaminhar o stdout da Evolution para um destino persistente (driver de logs com retenção maior ou coletor) e subir o nível de log do Baileys para `error`/`warn`. É mudança de infraestrutura (variável de ambiente + reimplantação da Evolution): só com autorização e fora do horário comercial.
