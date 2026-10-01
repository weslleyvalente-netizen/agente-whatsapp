"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { useRealtime } from "@/lib/realtime";
import { apiFetch } from "@/lib/api";
import { OPERATIONS, OPERATION_LABELS, FUNNEL_STAGE_LABELS, matchesOpportunitySearch, sortNewestSalesCards } from "@aula-agente/shared";
import type { Operation } from "@aula-agente/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OpportunityKanban, type OpportunityWithContact } from "@/components/opportunities/opportunity-kanban";
import { Input } from "@/components/ui/input";
import { OpportunityDetailDialog } from "@/components/opportunities/opportunity-detail-dialog";
import { OpportunityForm } from "@/components/opportunities/opportunity-form";

export default function OpportunitiesPage() {
  const { currentOrg } = useOrganization();
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const [searchSelected, setSearchSelected] = useState<OpportunityWithContact | null>(null);
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
      const data = await apiFetch(`/organizations/${currentOrg.id}/opportunities${searching ? "" : `?status=${status}`}`);
      setOpportunities(data);
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
    () => opportunities.filter((o) => o.operation === operation),
    [opportunities, operation]
  );

  const searchResults = useMemo(() => sortNewestSalesCards(opportunities.filter(o => matchesOpportunitySearch(o, query))), [opportunities, query]);

  useEffect(() => {
    fetchOpportunities(true);
  }, [fetchOpportunities]);

  useEffect(() => {
    if (!currentOrg?.settings.sales_workspace_enabled) return;
    const timer = setInterval(() => { fetchOpportunities(); }, 30000);
    return () => clearInterval(timer);
  }, [currentOrg, fetchOpportunities]);
  useRealtime({ table: "conversations", filter: currentOrg ? `organization_id=eq.${currentOrg.id}` : undefined, onUpdate: () => { fetchOpportunities(); }, enabled: currentOrg?.settings.sales_workspace_enabled === true });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Funil de vendas</h1>
        <OpportunityForm key={operation} operation={operation} onSaved={fetchOpportunities} />
      </div>
      <div className="flex items-center gap-2"><Input aria-label="Buscar no funil" placeholder="Buscar nome, telefone, modelo, observações..." value={query} onChange={e => setQuery(e.target.value)} />{searching && <Button variant="outline" onClick={() => setQuery("")}>Limpar busca</Button>}</div>
      {searching && <p className="text-sm text-muted-foreground">Busca em todos os funis e situações, incluindo ganhos e perdidos.</p>}
      {!searching && <><label className="flex items-center gap-2 text-sm">Situação<select className="rounded border bg-background p-2" value={status} onChange={e => setStatus(e.target.value)}><option value="open">Em andamento</option><option value="won">Ganhos</option><option value="lost">Perdidos</option></select></label>
      <Tabs value={operation} onValueChange={(v) => setOperation(v as Operation)}>
        <TabsList>
          {OPERATIONS.map((op) => (
            <TabsTrigger key={op} value={op} className="gap-1.5">
              {OPERATION_LABELS[op]}
              <Badge variant={op === operation ? "default" : "secondary"}>{countsByOperation.get(op) ?? 0}</Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs></>}
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
        <OpportunityKanban workspaceEnabled={currentOrg?.settings.sales_workspace_enabled === true && status === "open"} operation={operation} opportunities={opportunitiesForTab} onChanged={fetchOpportunities} />
      )}
    </div>
  );
}
