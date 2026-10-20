# Financiamento multibancos — preparação em mock

## Arquitetura e limites

CRM/Mariana: `apps/web` (Next.js), `apps/api` (Fastify), `apps/worker` (BullMQ), Supabase por organização. Catálogo: repositório independente `catalogo-motos-site`, Supabase próprio, incorporado por iframe. `packages/agent-runtime/src/tools/search-catalog.ts` usa exclusivamente estoque público; não recebe placa/FIPE nem ferramenta de crédito.

O adaptador `CredProMockAdapter` é uma fixture LOCAL. Seus bancos `mock-approved`, `mock-rejected`, `mock-error`, `mock-simulation` e parcelas são fictícios. Não representa o contrato HTTP da CredPro, cobertura bancária ou condições comerciais. Não há implementação de produção nem requisições de rede de crédito no fluxo CRM. O modo `sandbox` do worker continua bloqueado. Há um cliente HTTP separado, exclusivamente para exemplos sintéticos; ver docs/credpro-sandbox.md. Ele não lê fichas reais nem usa a fila CRM.

## Fluxo backend

1. Vendedor responsável ou gestor registra consentimento com evidência, validade, lista de bancos mock e autorização separada para uma reconsulta.
2. Cria ficha com veículo escolhido (`vehicle_id`) e qualificação mais recente do contato (CPF, nascimento, CNH, telefone e preferências). Estoque disponível é lido no servidor em projeto explicitamente vinculado à organização. Snapshot completo cifrado AES-256-GCM; fingerprint HMAC; nenhum CPF/placa/chave vai ao Redis.
3. Idempotency-Key UUID obrigatória. Repetição com dados diferentes devolve conflito; mesma ficha retorna a mesma consulta. RPC e chave única são a autoridade, não a fila.
4. Worker repetível a cada minuto, habilitado só com `FINANCING_MODE=mock`, recupera leases expiradas. Adaptadores executam em paralelo. Erro de um banco não impede outros; estados pendentes/recusados/simulação/erro/pré-aprovado são separados.
5. Resultados, eventos e alerta são gravados atomicamente. Visíveis no detalhe da oportunidade e em Notificações ao responsável atual (Marina ou Márcio conforme atribuição existente), e gestores da mesma organização. Não escolhe vendedor por nome fixo nem redistribui leads.
6. Cancelar revoga autorização; conclusão/perda da oportunidade cancela imediatamente via trigger privado. Reabertura não ressuscita consulta antiga.
7. Reconsulta: somente todos recusados, consentimento válido autorizando reconsulta, primeira tentativa, modo mock. Último dia útil do mês; primeira consulta nesse dia (ou depois) vai ao mês seguinte. Calendário de feriados explícito obrigatório. Scheduler só executa no último dia útil validado e cria no máximo uma tentativa adicional por raiz; janela perdida não é adiada indefinidamente. Revogação é revalidada ao concluir.

Nenhuma rota/fila de envio WhatsApp é chamada. Envio de proposta mediante ação do vendedor continua uma evolução futura.

## Rotas (autenticadas)

- `POST /opportunities/:id/financing/consents`: `{evidence, expires_at, banks, allow_requery}`.
- `POST /opportunities/:id/financing/requests`: `{consent_id, vehicle_id}`, cabeçalho `Idempotency-Key` UUID.
- `GET /opportunities/:id/financing`: histórico sanitizado, sem ficha cifrada/CPF/placa.
- `POST /opportunities/:id/financing/cancel`: revogação e cancelamento.
- `GET /organizations/:id/financing/alerts`: resultados internos do responsável atual/gestor.

Não há formulário de disparo no painel nesta etapa: a entrega prioriza cadastro FIPE e módulo backend. Histórico/cancelamento/alertas têm interface de leitura. Para homologação, chamar rotas com sessão autorizada e somente dados sintéticos.

## Configuração pendente (servidor)

Aplicar a migração `supabase/migrations/20261022120000_financing_mock.sql` no Supabase do CRM, após revisão/homologação. Não foi aplicada remotamente.

- API + worker: `FINANCING_MODE=mock` (ausente = desativado).
- API: `CATALOG_ORGANIZATION_ID`, `CATALOG_SUPABASE_URL`, `CATALOG_SUPABASE_SERVICE_ROLE_KEY`, somente servidor. Vinculam o estoque externo à organização correta.
- API + worker: chaves existentes `QUALIFICATION_CPF_ENCRYPTION_KEY` e `QUALIFICATION_CPF_HASH_PEPPER`; manter estáveis e provisionar por secret manager. Rotação requer migração dos snapshots existentes, como nos CPFs existentes.
- Worker: `FINANCING_BUSINESS_CALENDAR` JSON com `years` explicitamente validados e `holidays` ISO completos (nacionais, locais e calendário acordado com provedor). Ausente/inválido/sem ano = reconsulta automática bloqueada. Não há calendário brasileiro presumido.

Tabelas financeiras negam leitura/gravação direta a anon/authenticated; API faz autorização estrita independentemente da flag legada de isolamento de vendedor. Não adicionar snapshots/cabeçalhos de autorização aos logs ou ferramentas da Mariana.

## CredPro: fontes oficiais verificadas em 20/10/2026

- https://www.ecredpro.com/desenvolvedores/docs/comecando
- https://www.ecredpro.com/desenvolvedores/docs/simulacoes

Documentação descreve sandbox com chave de teste, consulta assíncrona e polling. Registrei essas fontes, mas não repliquei endpoints HTTP no adaptador local e não executei chamadas. Não assumir suporte a todas as motos, alternativas 36/48, preço, credenciais de banco ou idempotência remota por inferência. A página pública não comprova permissão contratual para reconsultas mensais: bloqueada em qualquer futuro adaptador real até confirmação formal. Antes de conectar sandbox: validar OpenAPI, tratamento de status, mapeamento de veículo/combustível, limites, credenciais de teste e garantia de idempotência/reconciliação após timeout. Produção exige autorização específica e credenciais; nunca habilitar por simples troca de chave.

## Riscos / próximos passos antes de produção

Confirmar licença/termos FIPE e regras do provedor. Validar migrações e comportamento no ambiente Supabase hospedado (testes atuais são locais). Definir retenção/expurgo de fichas e evidências; hoje não há expurgo automático. Revalidar veículo e dados atuais antes de eventual consulta REAL/reconsulta; snapshots atuais são a ficha original, apropriada ao mock. Alertas são internos com polling de 30s, sem push de financiamento nem envio ao cliente. Definir formulário de consentimento/disparo e revisão humana da ficha antes de integrar provedor real.

## Área dos vendedores e portal Ferramentas

A rota autenticada `/financiamento` reúne cliente/negócio atribuído, veículo disponível, autorização com validade, bancos mock, criação idempotente e histórico. O menu de vendedores inclui Financiamento. `GET /organizations/:id/financing/workspace` aplica isolamento estrito e não projeta dados privados do estoque ou qualificação. A referência de tentativa pendente sobrevive à navegação na mesma sessão e é reconciliada por chave antes de criar nova consulta. Sem armazenamento de sessão, o POST é bloqueado.

O card do portal público é aplicado separadamente com `integrations/ferramentas/add_financing_card.py`; aponta para `https://crm.motoetrilha.com.br/financiamento`, com indicação de testes. Não publicar antes da rota/API e das configurações pendentes. Nenhuma chave CredPro é solicitada na tela dos vendedores. O modo continua mock, mesmo após a homologação isolada do sandbox 1082.
