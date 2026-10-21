# Card de consulta de financiamento

Portal público: `https://ferramentas.motoetrilha.com.br`. Destino protegido: `https://crm.motoetrilha.com.br/financiamento`, usando login do CRM. Contas de Propostas/Comissões são de outro serviço e não se tornam contas CRM automaticamente.

O portal não recebe chave CredPro, ficha, CPF, placa ou resultado. A tela do CRM continua exclusivamente mock. Não publicar o link antes da implantação da rota, API, migração anterior e configuração do estoque.

## Aplicação mínima no portal existente

Fonte local identificada: `/Users/weslleyvalente/Documents/Estudo de Grupos/portal-motoetrilha/coleta/index.html`. O serviço FastAPI `ferramentas`, projeto `painel-motoetrilha`, publica os assets via `pipeline.initialize()` preservando a coleta persistida. O portal não tem repositório Git identificado.

1. Obter o `index.html` atual do serviço e fazer backup.
2. Executar `python3 add_financing_card.py index-atual.html index-novo.html` e revisar o diff. O script acrescenta somente o card e é idempotente; falha se a estrutura mudar.
3. Substituir apenas o asset-fonte `index.html` na origem do serviço; preservar arquivos, credenciais, volume `/data`, seed e agendamento. Não substituir o serviço inteiro por um pacote antigo.
4. Atualizar a publicação dos assets pelo fluxo existente e verificar o card, os sete atalhos anteriores e a data da coleta. Rollback: restaurar o backup do HTML.

A cópia preparada nesta entrega inclui os sete atalhos observados em produção em 20/10/2026. A coleta/grupos não foi executada ou alterada.

## Configuração do CRM

API: `FINANCING_MODE=mock`, `CATALOG_ORGANIZATION_ID`, `CATALOG_SUPABASE_URL`, `CATALOG_SUPABASE_SERVICE_ROLE_KEY` e chave de criptografia existente. Aplicar antes as migrações da etapa anterior no CRM e no catálogo. O frontend usa somente a sessão Supabase e a URL pública da API já existentes; não configurar chave CredPro no frontend.

Os vendedores precisam ser membros da organização CRM e responsáveis pelos negócios. A lista mostra até 500 negócios abertos atribuídos de venda de veículos/financiamento e até 500 veículos disponíveis. Gestores veem a equipe. Nomes e IDs são privados ao login; dados de qualificação e FIPE ficam no backend.

Retomada da tentativa: `sessionStorage` guarda apenas chave de idempotência, ID de consentimento e ID de veículo, separados por usuário/organização/negócio. Ao voltar, o vendedor seleciona o negócio e usa “Retomar mesma consulta de teste”; o backend procura a solicitação original antes de um novo POST. Sem armazenamento disponível, a criação é bloqueada antes do POST. Limpar dados da sessão ou encerrar o navegador pode apagar a referência; conferir o histórico antes de preparar outra consulta. Revogar e descartar cancela solicitações/reconsultas do negócio e limpa a referência.

Pendências para produção: contrato de idempotência/recuperação CredPro, credenciais em segredo do backend, regras do provedor, autorização e homologação real específicas. A consulta sandbox 1082 não habilita consultas reais.

## Simulação com veículo fora do estoque

A área agora também aceita veículo avulso: tipo, marca, modelo, ano e valor de negociação; versão/código FIPE opcionais e manuais. O veículo fica apenas na ficha cifrada da consulta, sem criar item no catálogo. Estoque e sua configuração são necessários somente para a opção “Do estoque”. Aplicar também a migração `20261022122000_financing_external_vehicle.sql`, após a migração mock anterior, antes de implantar a nova API. A simulação avulsa continua exigindo negócio/cliente atribuído e autorização válida.
