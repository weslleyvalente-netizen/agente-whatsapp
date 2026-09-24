"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useOrganization } from "@/providers/organization-provider";
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
  const [operation, setOperation] = useState<Operation>("vehicle_sale");
  const [opportunities, setOpportunities] = useState<OpportunityWithContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetched once across all funnels (not per-tab) so every tab's badge count
  // is known without refetching on every switch; the Kanban below filters
  // this same list down to the selected operation.
  const fetchOpportunities = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/organizations/${currentOrg.id}/opportunities`);
      setOpportunities(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

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
    fetchOpportunities();
  }, [fetchOpportunities]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Funil de vendas</h1>
        <OpportunityForm key={operation} operation={operation} onSaved={fetchOpportunities} />
      </div>
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
      {loading && <p className="text-sm text-muted-foreground">Carregando oportunidades...</p>}
      {!loading && error && (
        <div className="space-y-2 rounded border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <p className="text-destructive">Não foi possível carregar as oportunidades: {error}</p>
          <Button variant="outline" size="sm" onClick={fetchOpportunities}>
            Tentar novamente
          </Button>
        </div>
      )}
      {!loading && !error && (
        <OpportunityKanban operation={operation} opportunities={opportunitiesForTab} onChanged={fetchOpportunities} />
      )}
    </div>
  );
}
