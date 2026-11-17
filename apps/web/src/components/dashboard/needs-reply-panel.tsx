import Link from "next/link";
import { attentionListTotal, contactDisplayName, formatWaiting, funnelConversationHref, type AttentionList, type AttentionQueue } from "@aula-agente/shared";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Resposta de GET /organizations/:id/dashboard/needs-reply quando a flag está ligada. */
export type NeedsReplyData = AttentionQueue & { enabled: true; truncated?: boolean; ownerNames: Record<string, string> };

type Item = AttentionList["items"][number];

function Row({ item, ownerNames, showOwner }: { item: Item; ownerNames: Record<string, string>; showOwner: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{contactDisplayName(item.contactName, item.contactPhone)}</p>
        {showOwner && item.ownerUserId && <p className="truncate text-xs text-muted-foreground">{ownerNames[item.ownerUserId] ?? "—"}</p>}
      </div>
      <span className="tabular-data shrink-0 text-xs text-muted-foreground">esperando há {formatWaiting(item.waitingMinutes)}</span>
      <Link href={funnelConversationHref(item.conversationId)} className={buttonVariants({ size: "sm", variant: "outline" })}>Abrir</Link>
    </div>
  );
}

function List({ title, hint, list, ownerNames, showOwner, empty }: { title: string; hint: string; list: AttentionList; ownerNames: Record<string, string>; showOwner: boolean; empty: string }) {
  const olderHidden = list.older.total - list.older.items.length;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}{list.total > 0 && <Badge variant="outline" className="tabular-data ml-2">{list.total}</Badge>}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {list.items.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{list.older.total > 0 ? "Nenhum caso de até 7 dias." : empty}</p>
      ) : (
        <div className="divide-y divide-border">
          {list.items.map((item) => <Row key={item.conversationId} item={item} ownerNames={ownerNames} showOwner={showOwner} />)}
          {list.total > list.items.length && <p className="py-2 text-xs text-muted-foreground">+{list.total - list.items.length} mais recentes na fila (a lista mostra os que esperam há mais tempo)</p>}
        </div>
      )}
      {list.older.total > 0 && (
        <details className="mt-1 rounded-md border border-border px-3 py-1">
          <summary className="cursor-pointer select-none py-1.5 text-sm text-muted-foreground">
            Mais de 7 dias<Badge variant="outline" className="tabular-data ml-2">{list.older.total}</Badge>
          </summary>
          <div className="divide-y divide-border">
            {list.older.items.map((item) => <Row key={item.conversationId} item={item} ownerNames={ownerNames} showOwner={showOwner} />)}
            {olderHidden > 0 && <p className="py-2 text-xs text-muted-foreground">+{olderHidden} mais recentes entre os de mais de 7 dias</p>}
          </div>
        </details>
      )}
    </div>
  );
}

/** Bloco "Precisam de resposta": cliente aguardando resposta + lead sem primeiro atendimento (mais antigo primeiro). */
export function NeedsReplyPanel({ data }: { data: NeedsReplyData }) {
  const showOwner = data.unowned !== null; // gestor vê vários vendedores; vendedor só vê os próprios
  return (
    <Card>
      <CardHeader><CardTitle>Precisam de resposta</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        {data.truncated && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Lista parcial: há mais casos do que o limite de consulta. Os números abaixo são o mínimo e aparecem primeiro os mais antigos.</p>}
        <List title="Cliente aguardando resposta" hint="mensagem do cliente sem resposta humana" list={data.awaiting} ownerNames={data.ownerNames} showOwner={showOwner} empty="Nenhum cliente aguardando resposta." />
        <List title="Lead sem primeiro atendimento" hint="lead recebido, ainda sem mensagem humana" list={data.newLeads} ownerNames={data.ownerNames} showOwner={showOwner} empty="Nenhum lead sem primeiro atendimento." />
        {data.unowned && (attentionListTotal(data.unowned.awaiting) > 0 || attentionListTotal(data.unowned.newLeads) > 0) && (
          <div className="space-y-4 border-t border-border pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sem dono (visível só para gestores)</p>
            <List title="Cliente aguardando resposta" hint="sem vendedor atribuído" list={data.unowned.awaiting} ownerNames={data.ownerNames} showOwner={false} empty="Nenhum." />
            <List title="Lead sem primeiro atendimento" hint="sem vendedor atribuído" list={data.unowned.newLeads} ownerNames={data.ownerNames} showOwner={false} empty="Nenhum." />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
