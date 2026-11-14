# Alerta de falha definitiva de envio

## Problema
Uma mensagem comercial que esgota as tentativas de envio ficava só no log do BullMQ. Desde a #98 ela é marcada (`send_failed_at`) e o inbox mostra o tique de falha, mas ninguém era avisado.

## O que faz
Quando a **última tentativa** falha e a marca é gravada **pela primeira vez**, envia push (somente push):
- **vendedor responsável** pela conversa: "Sua mensagem para <cliente> não foi enviada (instância X)"; para resposta automática da MarIAna: "A resposta automática para <cliente>...". Link para a conversa.
- **sem responsável**: os gestores (owner/admin) recebem o aviso da conversa.
- **rajada** (3 ou mais falhas na organização em 15 min): os gestores recebem UM aviso agregado ("N mensagens não foram enviadas nos últimos 15 min (instância X)"), com link para as Configurações.
- Deduplicação por conversa e por janela de 30 min (`push_notification_log`). Contato sem nome aparece como "um cliente". O aviso **nunca** inclui o texto da mensagem, telefone ou chaves.

## Ativação
Opt-in: `organizations.settings.send_failure_alerts_enabled === true` **e** `push_notifications_enabled === true`. Sem as duas, nada acontece. Sem migração.

## Segurança
Nunca lança (falha no alerta não esconde o erro do envio); push que não entrega libera a chave para nova tentativa; erros no log saem sem telefones; reprocessar uma falha já marcada não repete o aviso.

## Fora do escopo (próximos passos)
Resumo diário de falhas para o gestor, ação "reenviar" no inbox e a varredura de leads sem resposta tratar `ai_processed` com resposta que falhou.

## Aceite na primeira ativação
Ligar em horário comercial; conferir que o vendedor responsável recebe 1 aviso por conversa, que não há duplicatas na janela e que o aviso agregado só aparece com 3+ falhas.
