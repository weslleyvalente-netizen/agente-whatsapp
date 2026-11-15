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
Opt-in separado: `send_failure_tasks_enabled === true` cria (ou atualiza, com dedupe por contato) a tarefa **"Mensagem não enviada"** (prioridade alta, hoje), atribuída ao responsável da conversa; sem responsável fica **sem responsável** (nunca "da IA"), visível na fila dos gestores (Tarefas e "Hoje") e também para os vendedores. Com a consolidação ligada entra como pendência na tarefa aberta do negócio. O tipo não entra no follow-up automático nem conta como sinal comercial.

### Referência da falha e encerramento
Cada falha guarda na pendência `failed_messages: [{message_id, conversation_id, failed_at}]`. Falhas seguidas (mesma conversa ou várias conversas do contato) **somam referências**, não se sobrescrevem; o texto passa a dizer "N mensagens".
O encerramento **automático** só ocorre quando uma mensagem aceita pela Evolution é **evidência de recuperação daquela mensagem**, na **mesma conversa**:
1. **Evidência forte (preferida):** é a mesma mensagem reprocessada, ou tem `metadata.resend_of` apontando para ela. Não depende de prazo nem de texto.
2. **Evidência por conteúdo (fraca, com salvaguardas):** mesmo texto e mesma mídia, **até 2 h depois** da falha, texto com **24+ caracteres**, e a mensagem aceita **não é automática** (follow-up, cadência de baixa intenção, encerramento de anúncio). Um envio recupera **no máximo uma** falha por conteúdo. Mensagem comercial padronizada repetida mais tarde, texto curto ("Bom dia!") e mídia sem legenda **não** encerram nada.

Um "bom dia" ou outra resposta qualquer **não** encerra; outra conversa do mesmo contato também não. Se só parte das mensagens foi recuperada, a pendência continua com as restantes. Hoje nenhuma tela grava `resend_of`: um botão "Reenviar" que o grave é a evolução natural (fora desta PR).

**Mesma mensagem recuperada:** se a mensagem marcada com `send_failed_at` é depois aceita (a mesma linha reprocessada pelo worker; o eco do webhook não a recupera, porque mensagens marcadas como falha ficam fora do pareamento de eco), `setMessageEvolutionId` remove `send_failed_at`/`send_error` e grava `metadata.send_recovered_at`. O inbox volta a mostrar ✓/✓✓, e as consultas (resposta entregue, contagem de falhas, silêncio) a tratam como enviada.

**Manual:** o vendedor conclui a tarefa (ou, em tarefa consolidada, usa **"Confirmar reenvio"** no painel, que encerra só esta pendência). Se o vendedor reescrever a mensagem com outro texto, o encerramento é manual.

## Cobertura verificada em 14/11 (leitura)
- Vendedores com push ativo: Marina (2 assinaturas) e Márcio (3), com centenas de avisos push registrados na última semana, o último em 14/11.
- **O dono (único owner/admin) não tem nenhuma assinatura push ativa**: os avisos para gestores não chegariam a ninguém por push.
- 34% das conversas ativas (92 de 271 em 14 dias) não têm responsável na conversa; para elas o aviso vai a gestores. Por isso existe o canal persistente.

## Ativação
- Push: `send_failure_alerts_enabled === true` **e** `push_notifications_enabled === true`.
- Tarefa persistente: `send_failure_tasks_enabled === true`.
- Sem as chaves, nada acontece. Sem migração.

## Mensagens antigas e deduplicação
- **Idade:** falha de mensagem criada há mais de 120 min **não gera push** (reprocessamento de fila, backlog depois de uma queda: sem enxurrada), mas a **tarefa persistente continua sendo criada** (silenciosa, 1 por contato) até 72 h, para a falha comercial relevante ter como ser recuperada; acima de 72 h nada é criado. O alerta só dispara na última tentativa de um job em execução e só na primeira marcação.
- **Dedupe do push:** 1 aviso por conversa e usuário a cada **10 min** (uma falha posterior, depois da janela, avisa de novo). O agregado é 1 por 30 min e instância, mas **a cada 5 falhas a mais** avisa de novo. Nada fica escondido: a tarefa persistente registra a falha mesmo quando o push foi suprimido.

## Segurança
Nunca lança (falha no alerta não esconde o erro do envio); push que não entrega libera a chave para nova tentativa; erros no log saem sem telefones; reprocessar uma falha já marcada não repete o aviso.

## Fora do escopo (próximos passos)
Resumo diário de falhas para o gestor, ação "reenviar" no inbox e a varredura de leads sem resposta tratar `ai_processed` com resposta que falhou.

## Aceite na primeira ativação
Ligar em horário comercial; conferir que o vendedor responsável recebe 1 aviso por conversa, que não há duplicatas na janela e que o aviso agregado só aparece com 3+ falhas.

## Todos os caminhos de envio passam pelo mesmo registro (PR da API)
Worker (`send-message`), API do inbox (texto, áudio e anexo, em `message-send.service.ts`) e a varredura de segurança chamam **`reportSendFailure`** (`packages/database/src/queries/send-failure-report.ts`):
- **Uma vez por mensagem:** a reivindicação é atômica (`metadata.send_failure_reported_at`). Retry, reprocesso e chamadas simultâneas não repetem aviso nem tarefa. Mensagem que já tem id da Evolution (entregue) nunca é reivindicada.
- **Referência preservada:** a tarefa guarda `failed_messages` (mensagem, conversa, hora). Falhas simultâneas que criem duas tarefas do mesmo contato são convergidas numa só (a mais antiga fica; referências somadas; a duplicada é cancelada; tarefa com outra obrigação nunca é cancelada).
- **Lacuna corrigida no worker:** áudio/anexo do vendedor já chegam marcados (`markSellerAudioFailed`) e antes isso calava o alerta. Agora são reportados.
- **Texto da API que falha antes de enfileirar:** antes ficava sem marca (parecia enviado). Agora é marcado e reportado.
- **Nada se perde:** se os canais estão desligados ou a tarefa falha, a reivindicação é devolvida. A varredura (`reconcileUnreportedSendFailures`, a cada 5 min junto da varredura de leads sem resposta) refaz as falhas das últimas 72 h sem relato. Só roda em organizações com `send_failure_tasks_enabled` **e** `send_failure_reconcile_enabled`. Sem as flags, nenhuma consulta de mensagens.
- **Ao ligar a varredura:** falhas marcadas nas últimas 72 h e sem relato (inclusive as de antes do deploy) viram tarefas silenciosas (sem push se tiverem mais de 120 min). Ligue por último e confira a fila.

Recuperação continua só por evidência (ver acima). Áudio/anexo (conteúdo `[audio]`/`[imagem]`) só fecham por id, `resend_of` ou confirmação manual.
