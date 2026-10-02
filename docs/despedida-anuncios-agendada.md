# Despedida de leads de anúncio sem continuidade

Pedido de 02/10/2026: separar tarefas de cliques de anúncio sem resposta posterior e enviar uma despedida no sábado, 03/10, das 8h às 18h de Brasília, com intervalo mínimo de 15 minutos. Texto aprovado: “Vou encerrar por aqui por enquanto 😊 Quando quiser retomar, é só me mandar uma mensagem. Seguimos à disposição para tirar suas dúvidas e ajudar você a escolher a melhor opção!”

## Seleção e agenda

Levantamento conservador: 20 contatos, 33 tarefas abertas; 11 LiberaCred, 7 consórcio e 2 exterior. Arthur incluído. Mensagem inicial única igual a uma das quatro mensagens prontas observadas nos anúncios; sem segunda resposta em qualquer conversa, mensagem humana, handoff real, negócio, cadastro/urgência/uso informados ou contato bloqueado/ignorado. Apenas tarefas da IA de customer_unresponsive/return_customer, sem pendência diferente, envio pendente ou alteração posterior ao manifesto. Registros antigos sem id de envio permanecem elegíveis: não se assume entrega dos retornos antigos; a confirmação obrigatória é da nova despedida.

Um contato por posição, alternando grupos enquanto houver contatos de grupos diferentes. Primeiro horário 8h, último previsto 12h45; o worker existente roda a cada 15 minutos, portanto os horários são posições mínimas, não promessa de minuto exato. Atrasos podem usar o restante da janela até 18h. Não há envio em rajada após atraso, transbordamento automático para outro dia ou seleção dinâmica de pessoas novas. Intervalo mínimo entre tentativas efetivas por instância é 15 minutos; teto desta fila é 40/dia ou o limite menor de follow-up configurado. Não é garantia contra bloqueio.

## Comportamento

A lista aprovada fica em organizations.settings.scheduled_ad_closure_batch; scheduled_ad_closure_enabled controla novos envios, ausente=false. O texto é um snapshot do aprovado ao agendar; posteriores edições da despedida valem para novos atendimentos. Configurações mostra a quantidade/intervalo e permite pausar. Pausar interrompe novas tentativas, mas confirmações de uma tentativa já feita ainda podem concluir as tarefas.

Antes do envio: recarrega configuração, todas as conversas/mensagens/tarefas do contato e o cadastro. Resposta, intervenção humana, handoff, negócio, alteração ou outra pendência impedem envio/conclusão. Cada mensagem é gravada somente quando a posição fica disponível, com metadata scheduled_ad_closure.batch_id. CAS persistente grava attempted_at e ajusta created_at para o instante do envio antes da chamada à Evolution: permite casar o eco de texto pela janela existente de 2 minutos. Mensagem cancelada não entra no casamento de eco. Papel agent, sem takeover ou handoff_events.

Fila send-message com attempts:1 e timeout de 30s para este tipo de envio. Redelivery, reinício ou perda do limitador Redis não fazem uma segunda tentativa após attempted_at. Timeout ou ausência de key.id mantêm tarefas abertas; não há retry automático. Eco confirmado ou resposta com id confirmam o envio. A rotina reconciliadora conclui tarefas com CAS de updated_at e evento completed com texto/id/lote/pendências resolvidas. Tarefas são preservadas, não excluídas. Recupera evento se houver falha após conclusão. Resposta/edição posterior conserva tarefas para revisão.

O fluxo antigo fica suprimido para os contatos do lote sem continuidade, inclusive antes do horário, em pausa e depois de enviados. Retornos automáticos antigos já enfileirados são reconferidos e suprimidos; mensagens normais de conversa e outros contatos seguem seu fluxo. Não marca oportunidade como perdida, não ativa outras automações e não fecha conversa indiscriminadamente.

## Configuração da despedida contínua

Configurações → Follow-up e despedida: texto editável (até 1000 caracteres, sem placeholders) e espera após o segundo retorno (0,25–168h, padrão 1h). Campos disponíveis com automação desligada. sales_low_intent_closing_message e sales_low_intent_final_delay_hours são salvos com trava das configurações, preservando a agenda. Cadência contínua depende de sales_low_intent_cadence_enabled, que permanece desligada nesta operação histórica. Novos envios registram confirmed_at; o prazo da despedida parte da primeira confirmação efetiva do segundo retorno (inclusive eco), respeita horário de atendimento e cancela com resposta. Compatibilidade para registros antigos usa created_at quando não há confirmed_at.

## Publicação e registro

Sem migration: usa settings, metadata e eventos já existentes. 886 testes, tipos e build web passaram. Testes de seleção/agenda, confirmação, timeout, redelivery, janela/pausa, proteção das tarefas, recuperação de eventos e exclusão da cadência antiga. Publicar a branch após suítes, tipos e build web; verificar Success de API/worker/web e saúde. Nenhuma mensagem real é enviada como teste.

Script packages/database/scripts/schedule-ad-closure-batch.ts: dry-run por padrão, manifesto local com permissão 0600 e sem dados de CPF/telefone. --apply exige o manifesto e contagens esperadas; revalida todos os destinatários antes de atualizar settings com CAS. Registro não envia mensagem nem altera tarefa. Repetição do mesmo lote não duplica/reativa; recusa substituir lote existente.

Comando dry-run (na raiz, ambiente configurado):

```sh
node --env-file=.env --experimental-strip-types packages/database/scripts/schedule-ad-closure-batch.ts --org cf01d00d-77f9-42bf-afd7-f22819f201c8 --start 2026-10-03T11:00:00Z --end 2026-10-03T21:00:00Z --output /private/tmp/ad-closure-2026-10-03.json
```

Registro, após conferência de 20 contatos e 33 tarefas:

```sh
node --env-file=.env --experimental-strip-types packages/database/scripts/schedule-ad-closure-batch.ts --org cf01d00d-77f9-42bf-afd7-f22819f201c8 --apply --manifest /private/tmp/ad-closure-2026-10-03.json --expected-contacts 20 --expected-tasks 33
```

Após a janela, consultar metadata/evolution_message_id, task_events e tarefas restantes: confirmadas/concluídas, canceladas por resposta/alteração, não confirmadas e não iniciadas. Não reenviar as não confirmadas automaticamente. Para interromper, desligar Fila de despedidas agendada em Configurações. Rollback de código exige pausar a fila primeiro; não apagar mensagem/tarefa/evento e não ligar o fluxo antigo em lote.
