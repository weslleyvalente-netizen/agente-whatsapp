# Evolution API 2.3.7 + ajuste do Baileys 7.0.0-rc.9: responde (ack) ao stanza <status>.
# Hipótese em teste (Baileys #2858 / Evolution #2778): a sessão cai ~50 min depois de conectar porque ninguém confirma o <status>
# ("Stream Errored (ack)", class="status") e às vezes volta "aberta mas surda". Nada além de UMA linha é acrescentada ao messages-recv.js;
# o build FALHA se qualquer premissa não bater. NÃO usar em produção sem seguir o ROTEIRO.md.
# Para o EasyPanel: Fonte > Dockerfile > colar este conteúdo.
#
# Base fixada por digest (amd64; conferir com `uname -m` no servidor). Digest da tag v2.3.7 no Docker Hub (atualizada em 2025-12-05).
FROM evoapicloud/evolution-api:v2.3.7@sha256:456b4104b0ddffbb092d6b3c0560a4ae86fc3e014e885b882aca4b1b371dfc81

RUN set -eu; \
    test "$(uname -m)" = "x86_64" || { echo "ERRO: o digest fixado e amd64; arquitetura aqui: $(uname -m)"; exit 1; }; \
    found="$(find / -xdev -path '*/node_modules/baileys/lib/Socket/messages-recv.js' 2>/dev/null)"; \
    test "$(printf '%s\n' "$found" | grep -c .)" = "1" || { echo "ERRO: esperava exatamente 1 messages-recv.js do Baileys; achei: $found"; exit 1; }; \
    f="$found"; \
    # O arquivo escolhido precisa ser o ÚNICO .js da aplicação que registra os handlers (nenhuma cópia empacotada em dist/).
    users="$(grep -rIl --include='*.js' "CB:ack,class:message" /evolution 2>/dev/null | grep -v '/node_modules/baileys/lib/Socket/messages-recv.js$' || true)"; \
    test -z "$users" || { echo "ERRO: outra copia do codigo do Baileys na aplicacao: $users"; exit 1; }; \
    pkg="$(dirname "$f")/../../package.json"; \
    grep -q '"version": "7.0.0-rc.9"' "$pkg" || { echo "ERRO: versao do Baileys diferente de 7.0.0-rc.9"; exit 1; }; \
    if grep -q "CB:status" "$f"; then echo "ERRO: ja existe um handler CB:status"; exit 1; fi; \
    test "$(grep -c "ws.on('CB:ack,class:message'" "$f")" = "1" || { echo "ERRO: ponto de insercao nao encontrado exatamente uma vez"; exit 1; }; \
    sed -i "s|ws.on('CB:ack,class:message'|ws.on('CB:status', (node) => { sendMessageAck(node).catch((e) => onUnexpectedError(e, 'acking status stanza')); }); &|" "$f"; \
    test "$(grep -c "ws.on('CB:status'" "$f")" = "1" || { echo "ERRO: patch nao aplicado"; exit 1; }; \
    node --input-type=module --check < "$f" || { echo "ERRO: erro de sintaxe depois do patch"; exit 1; }; \
    echo "Patch CB:status aplicado e sintaxe validada em $f"
