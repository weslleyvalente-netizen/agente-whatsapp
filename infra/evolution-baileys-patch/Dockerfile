# Evolution API 2.3.7 + ajuste do Baileys 7.0.0-rc.9: responde (ack) ao stanza <status>.
# HIPÓTESE EM TESTE: a sessão do WhatsApp fica "conectada mas surda" porque o Baileys não confirma esse aviso.
# Nada além de UMA linha é acrescentada ao messages-recv.js do Baileys; o build FALHA se qualquer premissa não bater.
# NÃO usar em produção sem seguir o ROTEIRO.md. Para o EasyPanel: Fonte > Dockerfile > colar este conteúdo.
#
# Fixe a versão pelo digest (copie do Docker Hub, aba Tags > v2.3.7) para um pull futuro não desfazer o ajuste:
#   FROM evoapicloud/evolution-api:v2.3.7@sha256:<DIGEST>
FROM evoapicloud/evolution-api:v2.3.7

RUN set -eu; \
    f="$(find / -xdev -path '*/node_modules/baileys/lib/Socket/messages-recv.js' 2>/dev/null | head -n 1)"; \
    test -n "$f" || { echo "ERRO: messages-recv.js do Baileys nao encontrado"; exit 1; }; \
    pkg="$(dirname "$f")/../../package.json"; \
    grep -q '"version": "7.0.0-rc.9"' "$pkg" || { echo "ERRO: versao do Baileys diferente de 7.0.0-rc.9"; exit 1; }; \
    if grep -q "CB:status" "$f"; then echo "ERRO: ja existe um handler CB:status"; exit 1; fi; \
    test "$(grep -c "ws.on('CB:ack,class:message'" "$f")" = "1" || { echo "ERRO: ponto de insercao nao encontrado exatamente uma vez"; exit 1; }; \
    sed -i "s|ws.on('CB:ack,class:message'|ws.on('CB:status', (node) => { sendMessageAck(node).catch((e) => onUnexpectedError(e, 'acking status stanza')); }); &|" "$f"; \
    test "$(grep -c "ws.on('CB:status'" "$f")" = "1" || { echo "ERRO: patch nao aplicado"; exit 1; }; \
    echo "Patch CB:status aplicado em $f"
