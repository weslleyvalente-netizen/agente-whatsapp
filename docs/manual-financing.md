# Consulta manual pelo portal Moto e Trilha

Rota: `https://crm.motoetrilha.com.br/financiamento`, protegida pelo login existente. Card em ferramentas aponta para essa rota. Membros vendedores veem apenas fichas próprias; owner/admin veem a equipe. A ficha é independente de negócio, conversa ou qualificação. Veículo pode ser do catálogo público vinculado à organização ou avulso; avulsos não alteram o estoque.

## Operação

Gestor abre **Configurar CredPro**, escolhe sandbox ou produção, informa chave completa e acessos bancários autorizados. Segredos são write-only, AES-256-GCM no servidor e nunca persistidos no navegador. Ao alterar, é necessário informar novamente todos os acessos que devem continuar ativos. **Testar conexão salva** usa apenas o GET gratuito `/v1/bancos`, sem criar consulta.

Sandbox aceita exclusivamente cenário sintético, sem campos de cliente real. Produção exige cliente, consentimento com evidência/validade, veículo e bancos configurados. Preparar ficha grava apenas no banco interno; **Enviar aos bancos** é uma ação posterior e explícita. Atualizar resultados busca o ID existente. As condições exibidas são somente as retornadas, sem inventar alternativas 36/48x. Erros de acesso/manutenção não são recusas de crédito. Não há envio de mensagem ao cliente.

## Veículos novos e usados (correção de 27/10/2026)

Selecionar **Novo / 0 km** ou **Usado** é obrigatório, tanto no estoque quanto no avulso. A origem do veículo não determina sua condição. Se o veículo já tem placa, o vendedor deve conferi-la e informá-la na ficha interna, inclusive para veículo do estoque: ela não é obtida da API pública do catálogo. São aceitos os formatos brasileiro antigo e Mercosul, com normalização de letras/hífen. A placa fica somente no JSON cifrado da ficha e no envio HTTPS ao provedor; revisão e histórico retornam apenas condição e presença da placa. Não persistir ficha em armazenamento do navegador nem registrar payloads em logs.

O envio usa o campo oficial `placa`, quando informado. Modelo e versão preenchida separadamente compõem `veiculo_modelo`, evitando repetição de termos. Essa composição não substitui a correspondência exata com o modelo do banco e não garante resolver todo erro de autocomplete. A condição é controle interno: não enviamos flags inventadas de novo/usado ou 0 km.

**PAN + moto sem placa está temporariamente bloqueado no preparo e no envio**, devido ao retorno real observado em 26/10/2026: fluxo manual de moto ainda não mapeado pelo provedor. O vendedor deve desmarcar PAN para seguir com os demais bancos ou informar uma placa real se disponível. A seleção de bancos nunca é alterada silenciosamente. A restrição se aplica a moto sem placa, nova ou usada; não é uma regra de concessão do PAN. O banco oferece financiamento de motos, mas isso não comprova cobertura desse fluxo na CredPro. Não habilitar com base no sandbox ou num exemplo de carro sem placa: o sandbox é fictício e a documentação não confirma PAN/moto sem placa. Remover o bloqueio somente após confirmação/homologação do provedor. Não inventar placa ou trocar a categoria do veículo.

Fichas reais preparadas antes desta atualização, sem condição explícita, não podem iniciar consulta: cancelar e preparar outra ficha. Fichas já enviadas continuam com o mesmo ID para atualização e histórico, sem reenvio. Nenhuma migração ou nova variável de ambiente é necessária nesta correção, pois os dados ficam no campo cifrado existente. Credenciais e configuração atuais são preservadas. A comprovação de cobertura real por banco continua pendente; testes locais não chamam bancos nem consomem saldo.

## Provedor e limites

Contrato textual oficial reverificado em 27/10/2026: https://www.ecredpro.com/desenvolvedores/docs/simulacoes e https://www.ecredpro.com/desenvolvedores/docs/comecando . Apenas `POST https://cred-pro.com/v1/simulacoes`, `GET /v1/simulacoes/{id}` e `GET /v1/bancos`. Não há endpoint inferido de cancelamento ou reconciliação. Cobertura de bancos/categorias e cobrança dependem do contrato e acessos da loja; não há promessa de aprovação. Sem placa, o provedor usa marca/modelo/ano; disponibilidade e precisão variam por banco. Preço de negociação e código FIPE nunca são enviados como valor FIPE.

Intenção durável antes do único POST por ficha. Timeout, interrupção ou resposta inconclusiva mantém criação desconhecida e impede repetição automática. Verificar histórico com o provedor antes de qualquer nova ficha substituta. Não há recuperação automática de ID perdido entre resposta HTTP e persistência. Tentativas desconhecidas conservam vagas e exigem suporte/reconciliação antes de liberar capacidade. Respostas oficiais documentadas 401/402/422/429 com código exato de rejeição pré-criação finalizam a tentativa sem reenvio.

Portão Postgres compartilhado por hash HMAC da chave: intervalo mínimo 3,1 s por chamada e até três consultas ainda não finalizadas, inclusive canceladas em andamento. Revogar impede novo envio, remove resultados exibidos e conserva a trilha interna; uma consulta já enviada pode continuar na CredPro. GET de resultado existente após revogação apenas verifica conclusão e libera a vaga, descartando resultados.

## Configuração de implantação

Aplicar `supabase/migrations/20261022124000_manual_financing.sql` no CRM. API usa as chaves existentes `QUALIFICATION_CPF_ENCRYPTION_KEY` e `QUALIFICATION_CPF_HASH_PEPPER`; preservar ambas e o procedimento de backup/rotação. Nenhuma chave CredPro em variável NEXT_PUBLIC.

Estoque na API: `CATALOG_ORGANIZATION_ID`, `CATALOG_SUPABASE_URL`, `CATALOG_SUPABASE_ANON_KEY` (preferido, público/read-only); fallback legado `CATALOG_SUPABASE_SERVICE_ROLE_KEY`. Projeção limitada a id/marca/modelo/ano/preco/tipo, sem placa ou campos privados. Sem configuração, avulsos continuam disponíveis.

Manter `FINANCING_MODE` ausente: a consulta manual não depende dessa variável; o worker mock e a integração futura da IA permanecem desativados. Reconsulta mensal automática ainda não ligada nesta fase. A tela legada mock está em `/financiamento/crm` e requer suas migrações próprias; não é o destino do card.

A etapa FIPE de cadastro/catálogo permanece em PR separado, aguardando validação de licença/limites; não é dependência da consulta manual. Não é obrigatório informar valor ou data FIPE.

## Verificação

Testes de schema, transporte documentado, projeção segura, acesso por vendedor/org, não repetição e portões/revogação SQL. Builds API, worker e web verificados; nenhuma consulta real executada pelo agente. Teste conectado requer chave sandbox informada pelo gestor na própria tela.
