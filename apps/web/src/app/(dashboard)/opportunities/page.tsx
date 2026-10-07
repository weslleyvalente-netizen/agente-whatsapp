"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { useRealtime } from "@/lib/realtime";
import { apiFetch } from "@/lib/api";
import { OPERATIONS, OPERATION_LABELS, FUNNEL_STAGE_LABELS, matchesOpportunitySearch, sortNewestSalesCards, trailingThrottle } from "@aula-agente/shared";
import type { Operation, Task } from "@aula-agente/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OpportunityKanban, type OpportunityWithContact } from "@/components/opportunities/opportunity-kanban";
import { Input } from "@/components/ui/input";
import { OpportunityDetailDialog } from "@/components/opportunities/opportunity-detail-dialog";
import { ChatPanel } from "@/components/inbox/chat-panel";
import { Dialog,DialogContent,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import { TaskDetailPanel } from "@/components/tasks/task-detail-panel";
import { OpportunityForm } from "@/components/opportunities/opportunity-form";

export default function OpportunitiesPage() {
  const { currentOrg } = useOrganization();
  const [orphanTasks,setOrphanTasks]=useState<Array<Task & {queue_group:string;wa_contacts:{name:string|null;phone:string}|null}>>([]);
  const [orphanSelected,setOrphanSelected]=useState<(typeof orphanTasks)[number]|null>(null);
  const [unidentified,setUnidentified]=useState<{id:string;contact_id:string;last_message_at:string;wa_contacts:{name:string|null;phone:string}|null}[]>([]);
  const [unidentifiedSelected,setUnidentifiedSelected]=useState<string|null>(null);
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const [searchSelected, setSearchSelected] = useState<OpportunityWithContact | null>(null);
  const [queueView,setQueueView]=useState(true);
  const [freezeFilter,setFreezeFilter]=useState("active");
  const [status, setStatus] = useState("open");
  const [operation, setOperation] = useState<Operation>("vehicle_sale");
  const [opportunities, setOpportunities] = useState<OpportunityWithContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetched once across all funnels (not per-tab) so every tab's badge count
  // is known without refetching on every switch; the Kanban below filters
  // this same list down to the selected operation.
  const fetchOpportunities = useCallback(async (showLoading = false) => {
    if (!currentOrg) return;
    if (showLoading) setLoading(true);
    if (showLoading) setError(null);
    setRefreshError(null);
    try {
      // The three lists are independent: fetch them in parallel and show each as soon as it arrives.
      const jobs: Promise<unknown>[] = [apiFetch(`/organizations/${currentOrg.id}/opportunities${searching ? "" : `?status=${status}`}`).then(setOpportunities)];
      if (currentOrg.settings.sales_action_queue_enabled === true) jobs.push(apiFetch(`/organizations/${currentOrg.id}/opportunities/pending-tasks`).then(setOrphanTasks)); else setOrphanTasks([]);
      if (currentOrg.settings.sales_auto_pipeline_enabled === true) jobs.push(apiFetch(`/organizations/${currentOrg.id}/opportunities/unidentified`).then(setUnidentified)); else setUnidentified([]);
      await Promise.all(jobs);
    } catch (err) {
      if (showLoading) setError((err as Error).message);
      else setRefreshError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [currentOrg, status, searching]);

  const countsByOperation = useMemo(() => {
    const counts = new Map<Operation, number>();
    for (const o of opportunities) {
      counts.set(o.operation, (counts.get(o.operation) ?? 0) + 1);
    }
    return counts;
  }, [opportunities]);

  const opportunitiesForTab = useMemo(
    () => opportunities.filter((o) => (currentOrg?.settings.sales_action_queue_enabled === true && queueView || o.operation === operation) && (freezeFilter==="all" || (freezeFilter==="frozen" ? !!o.frozen_until && o.frozen_until>new Date().toLocaleDateString("en-CA",{timeZone:"America/Sao_Paulo"}) : !o.frozen_until || o.frozen_until<=new Date().toLocaleDateString("en-CA",{timeZone:"America/Sao_Paulo"})))),
    [opportunities, operation, freezeFilter, currentOrg, queueView]
  );

  const orphanTasksForSearch=useMemo(()=>orphanTasks.filter(t=>matchesOpportunitySearch({wa_contacts:t.wa_contacts,commercial_notes:t.description,next_action:t.title},query)),[orphanTasks,query]);
  const searchResults = useMemo(() => sortNewestSalesCards(opportunities.filter(o => matchesOpportunitySearch(o, query))), [opportunities, query]);

  useEffect(() => {
    fetchOpportunities(true);
  }, [fetchOpportunities]);

  // Background refreshes (timer and realtime) are throttled and skipped while the tab is hidden:
  // every conversation update used to trigger three full scans of the organization.
  const fetchRef = useRef(fetchOpportunities);
  useEffect(() => { fetchRef.current = fetchOpportunities; }, [fetchOpportunities]);
  const refreshQuietly = useMemo(() => trailingThrottle(() => { if (!document.hidden) fetchRef.current(); }, 15000), []);
  useEffect(() => () => refreshQuietly.cancel(), [refreshQuietly]);

  useEffect(() => {
    if (!currentOrg?.settings.sales_workspace_enabled && !currentOrg?.settings.sales_action_queue_enabled) return;
    const timer = setInterval(refreshQuietly, 30000);
    return () => clearInterval(timer);
  }, [currentOrg, refreshQuietly]);
  useRealtime({ table: "conversations", filter: currentOrg ? `organization_id=eq.${currentOrg.id}` : undefined, onUpdate: refreshQuietly, enabled: currentOrg?.settings.sales_workspace_enabled === true || currentOrg?.settings.sales_action_queue_enabled === true });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">Funil de vendas</h1><p className="mt-1 text-sm text-muted-foreground">Clientes, conversas e próximas ações em um só lugar.</p></div>
        <OpportunityForm key={operation} operation={operation} onSaved={fetchOpportunities} />
      </div>
      {orphanSelected && currentOrg && <TaskDetailPanel task={{...orphanSelected,conversations:null}} taskId={orphanSelected.id} organizationId={currentOrg.id} onClose={()=>setOrphanSelected(null)} onTaskChanged={()=>fetchOpportunities()} onTaskClosed={id=>setOrphanTasks(prev=>prev.filter(t=>t.id!==id))}/>}
      {unidentifiedSelected&&<Dialog open onOpenChange={open=>{if(!open)setUnidentifiedSelected(null)}}><DialogContent className="sm:max-w-4xl"><DialogHeader><DialogTitle>Atendimento — operação a identificar</DialogTitle></DialogHeader><div className="h-[65vh]"><ChatPanel compact conversationId={unidentifiedSelected} onClose={()=>setUnidentifiedSelected(null)} onConversationChanged={()=>fetchOpportunities()}/></div></DialogContent></Dialog>}
      <section aria-label="Busca e filtros do funil" className="space-y-3 rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2"><Input className="min-w-48 flex-1 rounded-full" aria-label="Buscar no funil" placeholder="Buscar nome, telefone, modelo, observações..." value={query} onChange={e => setQuery(e.target.value)} />{searching && <Button variant="outline" onClick={() => setQuery("")}>Limpar busca</Button>}</div>
      {searching && <p className="text-sm text-muted-foreground">Busca em todos os funis e situações, incluindo ganhos e perdidos.</p>}
      {currentOrg?.settings.sales_action_queue_enabled===true && !searching && status==="open" && <div className="flex flex-wrap gap-2"><Button variant={queueView?"default":"outline"} onClick={()=>setQueueView(true)}>Fila da Marina · todos os funis</Button><Button variant={!queueView?"default":"outline"} onClick={()=>setQueueView(false)}>Etapas comerciais</Button></div>}
      {!searching && <><label className="flex items-center gap-2 text-sm">Fila<select value={freezeFilter} onChange={e=>setFreezeFilter(e.target.value)} className="rounded border bg-background p-2"><option value="active">Para agir</option><option value="frozen">Congelados</option><option value="all">Todos</option></select></label><div className="flex w-fit flex-wrap gap-1 rounded-full bg-muted p-1" aria-label="Situação do negócio">{[{value:"open",label:"Em andamento"},{value:"won",label:"Ganhos"},{value:"lost",label:"Perdidos"}].map(item => <Button key={item.value} className="rounded-full" variant={status===item.value ? "outline" : "ghost"} aria-pressed={status===item.value} onClick={()=>setStatus(item.value)}>{item.label}</Button>)}</div>
      {!(currentOrg?.settings.sales_action_queue_enabled===true && queueView && status==="open") && <Tabs value={operation} onValueChange={(v) => setOperation(v as Operation)}>
        <TabsList className="h-auto flex-wrap">
          {OPERATIONS.map((op) => (
            <TabsTrigger key={op} value={op} className="gap-1.5">
              {OPERATION_LABELS[op]}
              <Badge variant={op === operation ? "default" : "secondary"}>{countsByOperation.get(op) ?? 0}</Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>}</>}
      </section>
      {refreshError && <p role="alert" className="text-sm text-destructive">A atualização falhou. O atendimento aberto foi preservado: {refreshError}</p>}
      {loading && <p className="text-sm text-muted-foreground">Carregando oportunidades...</p>}
      {!loading && error && (
        <div className="space-y-2 rounded border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <p className="text-destructive">Não foi possível carregar as oportunidades: {error}</p>
          <Button variant="outline" size="sm" onClick={() => fetchOpportunities(true)}>
            Tentar novamente
          </Button>
        </div>
      )}
      {!loading && !error && searching && <section className="space-y-3" aria-label="Resultados da busca"><p className="text-sm text-muted-foreground">{searchResults.length} negócio(s) encontrado(s)</p>{searchResults.map(o => <button key={o.id} type="button" className="block w-full rounded-lg border p-4 text-left hover:bg-muted/50" onClick={() => setSearchSelected(o)}><strong>{o.wa_contacts?.name || "Sem nome"}</strong><p className="text-sm text-muted-foreground">{o.wa_contacts?.phone} · {OPERATION_LABELS[o.operation]} · {o.status === "won" ? "Ganho" : o.status === "lost" ? "Perdido" : "Em andamento"} · {FUNNEL_STAGE_LABELS[o.stage] ?? o.stage}</p><p className="mt-1 text-sm">{o.product_model ?? o.product ?? o.next_action ?? "Abrir detalhes"}</p></button>)}{!searchResults.length && <p>Nenhum negócio encontrado. Confira também se o contato já possui uma oportunidade registrada.</p>}</section>}
      {searchSelected && <OpportunityDetailDialog opportunity={opportunities.find(o => o.id === searchSelected.id) ?? searchSelected} onClose={() => setSearchSelected(null)} onChanged={fetchOpportunities}/>}
      {!loading && !error && !searching && (
        <OpportunityKanban queueMode={currentOrg?.settings.sales_action_queue_enabled===true && queueView && status==="open"} workspaceEnabled={(currentOrg?.settings.sales_workspace_enabled === true || currentOrg?.settings.sales_action_queue_enabled === true) && status === "open"} operation={operation} opportunities={opportunitiesForTab} onChanged={fetchOpportunities} />
      )}
      <section aria-label="Outros atendimentos" className="space-y-3">
      {currentOrg?.settings.sales_action_queue_enabled===true && <details className="rounded-xl border bg-muted/20 p-4"><summary className="cursor-pointer font-medium">Pendências antigas sem negócio aberto ({orphanTasksForSearch.filter(t=>t.queue_group!=="no_response").length})</summary><p className="mt-2 text-sm text-muted-foreground">Tarefas preservadas. Revise aqui para vincular ao negócio correto; nenhuma foi excluída ou marcada como perdida.</p><div className="mt-3 flex flex-wrap gap-2">{orphanTasksForSearch.filter(t=>t.queue_group!=="no_response").map(t=><Button key={t.id} variant="outline" onClick={()=>setOrphanSelected(t)}>{t.wa_contacts?.name||t.wa_contacts?.phone} · {t.due_date}{t.type==="customer_unresponsive"?" · Sem resposta":""}</Button>)}</div></details>}
      {currentOrg?.settings.sales_action_queue_enabled===true && <details className="rounded-xl border bg-muted/20 p-4"><summary className="cursor-pointer text-muted-foreground">Sem resposta · tarefas antigas ({orphanTasksForSearch.filter(t=>t.queue_group==="no_response").length})</summary><p className="mt-2 text-sm text-muted-foreground">Fora da fila principal. Mantidas para revisão, sem envio ou encerramento automático.</p><div className="mt-3 flex flex-wrap gap-2">{orphanTasksForSearch.filter(t=>t.queue_group==="no_response").map(t=><Button key={t.id} variant="outline" onClick={()=>setOrphanSelected(t)}>{t.wa_contacts?.name||t.wa_contacts?.phone} · {t.due_date}</Button>)}</div></details>}
      {currentOrg?.settings.sales_auto_pipeline_enabled===true && <details className="rounded-xl border bg-muted/20 p-4"><summary className="cursor-pointer font-medium">A identificar ({unidentified.length})</summary><p className="text-sm text-muted-foreground">Contatos em atendimento sem negócio. A operação precisa ser identificada antes de criar o card.</p><div className="mt-3 flex flex-wrap gap-2">{unidentified.filter(row=>!searching || `${row.wa_contacts?.name??""} ${row.wa_contacts?.phone??""}`.toLowerCase().includes(query.toLowerCase())).map(row=><Button variant="outline" key={row.id} onClick={()=>setUnidentifiedSelected(row.id)}>{row.wa_contacts?.name||row.wa_contacts?.phone||"Contato"}</Button>)}</div></details>}
      </section>
    </div>
  );
}
