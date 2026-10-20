# CredPro: teste de integração isolado

Preparado em 20/10/2026. O painel autenticado confirmou a chave de sandbox ativa; o conteúdo não foi copiado para arquivos, código ou chat. O fluxo do CRM permanece exclusivamente mock e não usa esta chave.

## O que foi implementado

`CredProSandboxClient` chama os endpoints da documentação textual oficial: criação em `https://cred-pro.com/v1/simulacoes` e resultado em `/v1/simulacoes/{consulta_id}`. Não usa endpoints inferidos, não faz scraping e não envia dados de clientes. Apenas dois bancos dos exemplos documentados (PAN/C6), usuários/senhas fictícios e CPF/telefone/placa sintéticos podem entrar nesse teste.

Chaves reais são rejeitadas antes da rede. Toda resposta de sucesso deve provar `sandbox:true`. POST não é repetido automaticamente; em timeout ou resposta ambígua, conferir o histórico antes de tentar outra vez. A consulta retornada é acompanhada com espera de pelo menos 3,1 segundos entre requisições, uma ativa por cliente e número limitado de leituras. Uma oferta de 48x não cria artificialmente uma alternativa 36x. Falhas de credenciais/manutenção não viram recusas de crédito. Dados brutos, CPF, telefone, placa e chave não aparecem na saída do script.

O cliente isolado NÃO implementa o adaptador da fila CRM: não há acesso a fichas de clientes, migração de modo para sandbox, envio de WhatsApp ou execução de reconsulta mensal remota. Idempotência remota e persistência do identificador da consulta precisam ser validadas antes de conectar qualquer fila recuperável; por isso a integração com o worker continua bloqueada.

## Como homologar sem salvar a chave

Depois de compilar o pacote database, executar em um terminal local confiável:

```sh
node scripts/credpro-sandbox-smoke.mjs rejected
```

A chave é solicitada com entrada oculta. Colar somente a chave `cpk_test_...` e pressionar Enter. A chave fica apenas na memória desse processo e não é escrita em arquivo ou histórico de comandos. O destino é o serviço oficial CredPro; somente os exemplos sintéticos documentados são enviados. Não colar a chave no chat nem passá-la como argumento de linha de comando.

Cenários permitidos: `rejected`, `approved`, `mixed`. Cada execução cria UMA consulta sandbox com PAN/C6. Não executar cenários repetidamente se a criação falhar ou seu resultado for desconhecido; conferir o histórico primeiro. Credenciais reais de banco não são necessárias ao sandbox e não são aceitas por este script.

Alternativamente, um secret manager pode fornecer `CREDPRO_SANDBOX_KEY` apenas ao processo de homologação. A variável não deve ir para frontend, configuração pública, código, PR ou arquivo versionado. Não inserir essa chave em serviços de produção para ativar este teste: o worker ainda não a utiliza.

## Validação desta entrega

Testes automatizados usam transporte simulado; verificam criação/polling, prefixo de chave, dados fixos, resposta sandbox obrigatória, erro sem vazamento, ausência de repetição de POST, resultado incompleto e preservação de parcelas retornadas. Não comprovam, por si só, disponibilidade ou contrato real do provedor.

O link Swagger informado pela própria documentação (`https://www.ecredpro.com/docs`) retornou Not Found; a tentativa no domínio base `https://cred-pro.com/docs` também retornou HTTP 404. O GET documentado de bancos, sem chave, retornou HTTP 403. Isso não confirma funcionamento autenticado nem significa que uma chave de teste seja inválida. A documentação textual e a tela de sandbox estão acessíveis.

Homologação conectada concluída em 20/10/2026: consulta sandbox 1082, cenário sintético de recusa, PAN e C6 retornaram `recusado`, resposta com `sandbox:true`. O usuário inseriu a chave manualmente em formulário temporário servido somente em loopback; a chave permaneceu em memória e não foi copiada para arquivos, código ou chat. O formulário teve correções locais de origem e validação antes do envio válido; as tentativas com chave não reconhecida foram barradas antes da rede. Nenhum dado de cliente ou mensagem WhatsApp foi enviado. Este resultado comprova somente esse cenário sandbox, sem homologar produção, outros bancos ou regras de reconsulta.

## Fontes verificadas no portal do parceiro

- https://www.ecredpro.com/desenvolvedores/docs/comecando#sandbox
- https://www.ecredpro.com/desenvolvedores/docs/simulacoes
- https://www.ecredpro.com/parceiro-api-painel (conta autenticada; sem exportação de credenciais)

Os limites exibidos na conta são 3 consultas simultâneas e 20 por minuto. O espaçamento do teste é por instância local, não um limitador distribuído da conta. Não inferir suporte real para motos, preço contratual, autorização de reconsulta ou idempotência a partir de respostas sandbox.
