# Alerta de falha definitiva de envio

## Problema
Uma mensagem comercial que esgota as tentativas de envio ficava só no log do BullMQ. Desde a #98 ela é marcada (`send_failed_at`) e o inbox mostra o tique de falha, mas ninguém era avisado.

## O que faz
Quando a **última tentativa** falha e a marca é gravada **pela primeira vez**, envia push (somente push):
- **vendedor responsável** pela conversa: "Sua mensagem para <cliente> não foi enviada (instância X)"; para resposta automática da MarIAna: "A resposta automática para <cliente>...". Link para a conversa.
- **sem responsável**: os gestores (owner/admin) recebem o aviso da conversa.
- **rajada** (3 ou mais falhas na organização em 15 min): os gestores recebem UM aviso agregado ("N mensagens não foram enviadas nos últimos 15 min (instância X)"), com link para as Configurações.
- Deduplicação por conversa e por janela de 30 min (`push_notification_log`). Contato sem nome aparece como "um cliente". O aviso **nunca** inclui o texto da mensagem, telefone ou chaves.

## Canal persistente (sem depender de push)
Opt-in separado: `send_failure_tasks_enabled === true` cria (ou atualiza, com dedupe por contato) a tarefa **"Mensagem não enviada"** (prioridade alta, hoje), atribuída ao responsável da conversa; sem responsável fica sem atribuição (fila dos gestores). Com a consolidação ligada entra como pendência na tarefa aberta do negócio. A tarefa **se encerra sozinha** quando um envio posterior (um reenvio) é aceito na conversa; só a pendência desta falha, nunca as outras obrigações. O tipo não entra no follow-up automático nem conta como sinal comercial.

## Cobertura verificada em 14/11 (leitura)
- Vendedores com push ativo: Marina (2 assinaturas) e Márcio (3), com centenas de avisos push registrados na última semana, o último em 14/11.
- **O dono (único owner/admin) não tem nenhuma assinatura push ativa**: os avisos para gestores não chegariam a ninguém por push.
- 34% das conversas ativas (92 de 271 em 14 dias) não têm responsável na conversa; para elas o aviso vai a gestores. Por isso existe o canal persistente.

## Ativação
- Push: `send_failure_alerts_enabled === true` **e** `push_notifications_enabled === true`.
- Tarefa persistente: `send_failure_tasks_enabled === true`.
- Sem as chaves, nada acontece. Sem migração.

## Mensagens antigas e deduplicação
- **Idade:** falha de mensagem criada há mais de 120 min nunca alerta (reprocessamento de fila, backlog depois de uma queda). O alerta só dispara na última tentativa de um job em execução e só na primeira marcação.
- **Dedupe do push:** 1 aviso por conversa e usuário a cada **10 min** (uma falha posterior, depois da janela, avisa de novo). O agregado é 1 por 30 min e instância, mas **a cada 5 falhas a mais** avisa de novo. Nada fica escondido: a tarefa persistente registra a falha mesmo quando o push foi suprimido.

## Segurança
Nunca lança (falha no alerta não esconde o erro do envio); push que não entrega libera a chave para nova tentativa; erros no log saem sem telefones; reprocessar uma falha já marcada não repete o aviso.

## Fora do escopo (próximos passos)
Resumo diário de falhas para o gestor, ação "reenviar" no inbox e a varredura de leads sem resposta tratar `ai_processed` com resposta que falhou.

## Aceite na primeira ativação
Ligar em horário comercial; conferir que o vendedor responsável recebe 1 aviso por conversa, que não há duplicatas na janela e que o aviso agregado só aparece com 3+ falhas.
