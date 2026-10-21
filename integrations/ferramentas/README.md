# Card de consulta de financiamento

Portal público: https://ferramentas.motoetrilha.com.br . Destino autenticado: https://crm.motoetrilha.com.br/financiamento . Usa as contas CRM existentes; contas de Propostas/Comissões não viram contas CRM automaticamente. Operação e configurações: [manual-financing.md](../../docs/manual-financing.md).

O portal não recebe chave, ficha, CPF, placa ou resultado. Acrescentar somente o card ao `index.html` ATUAL do serviço, após publicar API/web e a migração manual.

1. Fazer backup do HTML atual; aplicar `add_financing_card.py` em outro arquivo e revisar o diff.
2. Substituir somente o asset-fonte index.html. Preservar os sete atalhos atuais, dados coletados, credenciais, volume `/data`, seed e agendamento.
3. Usar o fluxo existente de publicação de assets (`pipeline.initialize()`), sem executar a coleta. Verificar o card e os atalhos anteriores. Rollback: restaurar o HTML salvo.

Serviço FastAPI `ferramentas`, projeto EasyPanel `painel-motoetrilha`. Fonte local identificada anteriormente em `/Users/weslleyvalente/Documents/Estudo de Grupos/portal-motoetrilha/coleta/index.html`; a versão do serviço em execução é a referência ao publicar. Não trocar o serviço inteiro por arquivo antigo.
