# Consulta manual CredPro pelo card de ferramentas

**Escopo autorizado:** colocar o card e a consulta manual no site antes de automatizar IA/CRM. Mesmo login e membros CRM; ficha manual não depende de oportunidade/conversa. Estoque e avulso permitidos. Nenhuma ferramenta de IA, envio de WhatsApp ou reconsulta automática será ligada nesta fase.

**Arquitetura:** módulo manual com casos próprios (org/vendedor), ficha e credenciais cifradas, preparação idempotente seguida de ação explícita “Enviar aos bancos”. Adaptador HTTP usa somente POST /v1/simulacoes, GET /v1/simulacoes/{id}, GET /v1/bancos documentados e verificados no portal oficial em 21/10/2026. Configuração de API/bancos é apenas do gestor, write-only e cifrada. Não armazenar segredos ou ficha em localStorage/sessionStorage/logs.

**Segurança de execução:** cada caso tem no máximo um POST remoto, precedido por intenção durável. Timeout/reinício entre envio e gravação do ID vira criação desconhecida, nunca repetição automática. Resultado usa ID persistido, chave de modo correspondente e bancos esperados. Portas de acesso sempre por org e vendedor/gestor. Controle compartilhado de 20 chamadas/min e três consultas ativas por chave. Credencial inválida/manutenção/erro não são recusa. Apenas condições retornadas compõem proposta.

**Ambientes:** sandbox aceita somente exemplos sintéticos e exige sandbox:true; live exige chave de produção, credenciais de bancos selecionados e autorização válida. O agente não realizará consulta real. Configuração vazia começa desativada; usuário informa chave/credenciais em tela HTTPS no fim. Saldo/contrato do provedor são pendências para live.

## Execução

- [x] Atualizar branch com main e remover colisão de timestamp da migração mock ainda não aplicada.
- [x] Testes/cliente HTTP manual, validação de ficha e normalização estrita, sem endpoint inferido.
- [x] Migração de configurações/casos backend-only, intenção única, rate limit e estados recuperáveis; testes SQL de concorrência/autorização/revogação.
- [x] Rotas autenticadas para configuração, lista/preparo/envio/status/cancelamento; testes de isolamento e ausência de vazamento.
- [x] Tela manual e configuração de gestor, seleção estoque/avulso, revisão explícita e histórico; modo sandbox claramente fictício.
- [ ] Revisão independente, tipos/tests/build, PR; aplicar somente migrações novas, publicar API/web e somente o card no portal, preservando serviços, volume/coleta e funcionalidades existentes.
- [ ] Verificar no site e executar apenas prova sintética após usuário configurar chave de teste. Deixar live aguardando credenciais/autorizações reais se faltarem. Documentar pendências concretas.
