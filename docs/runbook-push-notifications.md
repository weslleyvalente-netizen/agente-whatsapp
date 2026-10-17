# Runbook — PWA e notificações push

Recurso inerte até que as chaves VAPID existam e a flag da organização seja ligada.

## 1. Gerar as chaves VAPID (uma vez)

```
npx web-push generate-vapid-keys
```

Guarde as duas chaves em local seguro. Nunca coloque no repositório.

## 2. Variáveis no EasyPanel

Criar nos serviços **api** e **worker** (mesmos valores nos dois):

| Variável | Valor |
|---|---|
| `VAPID_PUBLIC_KEY` | chave pública gerada |
| `VAPID_PRIVATE_KEY` | chave privada gerada |
| `VAPID_SUBJECT` | `mailto:contato@seudominio.com.br` (ou URL do site) |

Reiniciar api e worker depois de criar. Trocar as chaves invalida todas as assinaturas existentes (cada aparelho precisa ativar de novo).

## 3. Migration

Aplicar `supabase/migrations/20261018120000_push_notifications.sql` (tabelas `push_subscriptions` e `push_notification_log`) antes de ligar a flag.

## 4. Ligar para a organização

Configurações > Distribuição > "Notificações push para vendedores" (`settings.push_notifications_enabled`). Desligado por padrão.

## 5. Instalar e ativar no aparelho

**Android (Chrome):** abrir o CRM > menu (três pontos) > "Instalar app" / "Adicionar à tela inicial". Abrir pelo ícone > Configurações > "Notificações neste aparelho" > "Ativar notificações" > Permitir > "Enviar teste".

**iPhone (iOS 16.4 ou superior, Safari):** abrir o CRM no Safari > Compartilhar > "Adicionar à Tela de Início". Abrir **pelo ícone da Tela de Início** (o push não funciona na aba do Safari) > Configurações > "Ativar notificações" > Permitir > "Enviar teste".

## 6. O que dispara

Varredura do worker a cada 30 s, só para o vendedor dono do registro (gerentes não recebem a menos que sejam o dono):
1. Lead novo atribuído ("Novo lead: nome").
2. Mensagem de cliente em conversa do vendedor em atendimento humano ou ainda sem resposta humana (uma notificação por conversa por varredura).
3. SLA em risco: atribuição pendente com pelo menos 5 min de idade e a 15 min ou menos do vencimento (nunca junto com o "Novo lead"). Os três usam a tag da conversa: o aviso novo substitui o anterior do mesmo lead.

Teto: acima de 5 avisos para o mesmo vendedor numa varredura, ele recebe um único resumo ("N novos leads").

Só organizações com a flag ligada são consultadas; o destinatário precisa ser membro atual da organização (senão suas assinaturas são apagadas). Idempotência por `push_notification_log.dedupe_key`; o worker apaga linhas com mais de 7 dias, a cada hora. Ao reiniciar, o worker olha só os últimos 2 minutos.

## 7. Problemas comuns

- Nada chega: conferir variáveis nos dois serviços, flag ligada, migration aplicada e o aparelho com status "Ativas".
- iPhone sem opção de ativar: o app não foi aberto pelo ícone da Tela de Início.
- Ao sair do app (Sair), o aparelho é desvinculado do usuário. Um aparelho que já pertence a outro usuário e não consegue se desvincular devolve 409 ao ativar; desative as notificações nele e ative de novo.
- Assinaturas expiradas (HTTP 404/410 do serviço de push) são apagadas automaticamente.
