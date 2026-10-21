# Veículo fora do estoque em financiamento

**Objetivo:** escolher “Do estoque” ou “Fora do estoque” na mesma área protegida. A simulação avulsa continua vinculada a cliente/negócio, autorização e vendedor. Não cria anúncio nem item de estoque.

**Dados:** tipo, marca, modelo, ano do modelo e valor de negociação obrigatórios; versão e código FIPE opcionais, informados manualmente. Não exigir valor/data FIPE. Campos privados do catálogo continuam no backend.

**Persistência:** `vehicle_id` aceita null para veículo avulso; origem gerada no banco a partir desse vínculo. Ficha avulsa cifrada na solicitação, aproveitada na reconsulta sem depender do catálogo. Histórico retorna somente resumo sanitizado do veículo.

- [x] Testes API de payload exclusivo estoque/avulso, valores inválidos, independência do catálogo e projeção do histórico.
- [x] Migração incremental e testes SQL de estoque legado, avulso, idempotência e reconsulta.
- [x] Seletor/formulário avulso, envio e referência pendente sem ficha no armazenamento do navegador. Após refresh, se a tentativa avulsa não existir no backend, exigir revogar/descartar antes de preparar nova ficha; nunca inventar dados para retomar.
- [x] Tipos, testes dirigidos, build, navegador com dados fictícios, revisão e atualização do PR/relatório. Sem deploy/consulta real.

## Retomada em 21/10/2026

Arquivos originais recuperados do iCloud, preservados e validados em cópia temporária fora da sincronização. A publicação continua pendente das migrações/configurações anteriores; nenhuma consulta real foi executada.
