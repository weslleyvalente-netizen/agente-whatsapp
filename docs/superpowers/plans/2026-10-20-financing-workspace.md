# Consulta de financiamento para vendedores

> Executar nesta sessão com a habilidade executing-plans, preservando a branch de feature existente.

**Objetivo:** card no portal ferramentas levando a /financiamento do CRM autenticado, com preparação de ficha, registro de autorização, consulta mock e histórico. Nenhuma chamada real ou integração automática do sandbox sintético com clientes. Publicação em produção pendente das configurações da etapa anterior.

**Arquitetura:** portal público mantém apenas link para https://crm.motoetrilha.com.br/financiamento. API autenticada lista oportunidades abertas atribuídas ao vendedor (gestor vê as atribuídas da organização) e veículos disponíveis com projeção explícita; nenhuma placa/FIPE/CPF/chave no retorno. Tela usa endpoints existentes para consentimento, criação idempotente, histórico e cancelamento. Sem novas tabelas ou migrações nesta entrega.

**Visual:** preservar portal.css e tema/tipografia do CRM. Formulário e histórico em duas colunas no desktop, uma no celular; aviso visível de teste e botão “Consultar em teste”. Sem promessa de aprovação real.

## Tarefas

- [x] API: testes de autenticação, isolamento por organização/vendedor, projeção do estoque e falha segura de configuração; implementar GET /organizations/:organizationId/financing/workspace.
- [x] Interface: permitir oportunidade e veículo, bancos de teste, evidência/data de autorização e reconsulta opcional desligada; impedir clique duplicado e preservar chave de idempotência/consentimento em repetição após erro de rede; limpar estado ao trocar organização/oportunidade; navegar pelo menu existente.
- [x] Portal: copiar fonte local atual para pasta de entrega; acrescentar somente card, preservar sete links e coleta; empacotar arquivo e instruções de aplicação sem substituir serviço inteiro.
- [x] Verificação: testes dirigidos API/web, tipos/build, navegação local com dados fictícios, revisão independente e relatório. Atualizar PR existente; não publicar link que aponte para rota ainda não implantada.

## Riscos e configuração

FINANCING_MODE=mock, vínculo explícito CATALOG_ORGANIZATION_ID e credenciais de serviço do estoque apenas no backend. As migrações anteriores ainda precisam ser aplicadas antes de habilitar a tela. Produção e consultas reais permanecem bloqueadas; contrato de idempotência/recuperação do provedor ainda pendente.

## Resultado da revisão

Referências de tentativa persistidas em sessionStorage por usuário/organização/negócio; reconciliação autenticada antes de POST ao retomar. Recuperação permitida mesmo com estoque indisponível (o backend exige estoque para criar ficha nova). Revogação/descartar confirma cancelamento no backend antes de limpar referência. Mensagem de revogação preservada ao atualizar histórico.
