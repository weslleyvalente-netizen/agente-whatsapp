# Correções de continuidade e organização comercial

Branch: codex/fix-sales-attendance-continuity. Implementação autorizada; sem publicação até concluir verificação.

## Mudanças

1. Conservar a última mensagem recebida durante processamento ativo, além do agrupamento de mensagens de seis segundos.
2. Responder à pergunta atual: updateQualification é registro interno. Uma recuperação sem ferramentas quando a IA apenas pede espera indevidamente ou termina sem texto após cinco etapas. Handoff confirmado em falha repetida, preservando uso acumulado e trace. Não prometer aprovação bancária ou retirada imediata e não pressionar CPF.
3. Reconhecer intenção explícita de consórcio com pequeno ruído de digitação. Handoff comercial avança negociação conforme modalidade, respeitando resultados humanos e congelamento. Pronto para Marina permanece fila operacional existente.
4. Renovar apenas retornos automáticos vencidos diante de novo handoff comercial. Preservar tarefas/edições humanas, datas futuras, pendências internas, CPF, congelamento e envios pendentes. Registrar histórico e usar trava de updated_at.
5. Aviso no card após cinco minutos sem resposta da IA, excluindo takeover, IA desligada, handoff pendente, negócio encerrado e congelamento preenchido. O aviso não dispara mensagens.

## Banco e flags

Sem migration ou novas flags. Organização segue sales_auto_pipeline_enabled e sales_qualified_handoff_task_enabled. Visibilidade segue a visão operacional existente. Não publicar configurações do agente, alterar preços, enviar mensagens de teste ou revisar contatos em massa.

## Validação e publicação

Testes de regressão, compilação dos pacotes, tipos de API/worker/web e build web. Conferir casos de pergunta durante execução ativa, espera inadequada, intenção com erro de digitação, encaminhamento comercial e preservação das tarefas humanas. Redis de integração não está disponível localmente: teste da fila usa contrato de opções e revisão do código BullMQ instalado.

Após aprovação de publicação: push da branch e integração na main pelo processo autorizado; verificar deploy API/worker/web e saúde. Conferir Playground, novas mensagens reais e card pendente sem enviar testes a clientes. Rollback por reversão do commit; desligar automação comercial se necessário preserva registros históricos. O caso antigo de catálogo sem resposta não comprova sua causa pelos logs disponíveis e não será reenviado automaticamente.

A atualização de status/atribuição também usa updated_at: um reagendamento ou conclusão concorrente não pode ser reaberto pelo handoff. O Playground identifica updateQualification, requestHuman e sendRegisteredImage como SIMULADO, de acordo com a implementação sandbox do registro de ferramentas. A geração de recuperação com erro de rede termina no fallback sem repetir ferramentas anteriores.

## Resultado local em 04/10/2026

1.033 testes passaram (shared 345, database 81, runtime 205, API 267, worker 135). Compilações dos pacotes, tipos dos aplicativos e build web passaram. Sem migration, alterações de produção, envio ao cliente ou push. Validar no Playground catálogo, perguntas de entrada/CPF/financiamento e handoff após deploy.
