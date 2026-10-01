"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { useRealtime } from "@/lib/realtime";
import { apiFetch } from "@/lib/api";
import { OPERATIONS, OPERATION_LABELS } from "@aula-agente/shared";
import type { Operation } from "@aula-agente/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OpportunityKanban, type OpportunityWithContact } from "@/components/opportunities/opportunity-kanban";
import { OpportunityForm } from "@/components/opportunities/opportunity-form";

export default function OpportunitiesPage() {
  const { currentOrg } = useOrganization();
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
      const data = await apiFetch(`/organizations/${currentOrg.id}/opportunities?status=${status}`);
      setOpportunities(data);
    } catch (err) {
      if (showLoading) setError((err as Error).message);
      else setRefreshError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [currentOrg, status]);

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
      <label className="flex items-center gap-2 text-sm">Situação<select className="rounded border bg-background p-2" value={status} onChange={e => setStatus(e.target.value)}><option value="open">Em andamento</option><option value="won">Ganhos</option><option value="lost">Perdidos</option></select></label>
      <Tabs value={operation} onValueChange={(v) => setOperation(v as Operation)}>
        <TabsList>
          {OPERATIONS.map((op) => (
            <TabsTrigger key={op} value={op} className="gap-1.5">
              {OPERATION_LABELS[op]}
              <Badge variant={op === operation ? "default" : "secondary"}>{countsByOperation.get(op) ?? 0}</Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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
      {!loading && !error && (
        <OpportunityKanban workspaceEnabled={currentOrg?.settings.sales_workspace_enabled === true && status === "open"} operation={operation} opportunities={opportunitiesForTab} onChanged={fetchOpportunities} />
      )}
    </div>
  );
}
