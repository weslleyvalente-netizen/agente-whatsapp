"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { apiFetch } from "@/lib/api";
import { OPERATIONS, OPERATION_LABELS } from "@aula-agente/shared";
import type { Operation, Opportunity } from "@aula-agente/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OpportunityKanban } from "@/components/opportunities/opportunity-kanban";
import { OpportunityForm } from "@/components/opportunities/opportunity-form";

export default function OpportunitiesPage() {
  const { currentOrg } = useOrganization();
  const [operation, setOperation] = useState<Operation>("vehicle_sale");
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchOpportunities = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const data = await apiFetch(`/organizations/${currentOrg.id}/opportunities?operation=${operation}`);
    setOpportunities(data);
    setLoading(false);
  }, [currentOrg, operation]);

  useEffect(() => {
    fetchOpportunities();
  }, [fetchOpportunities]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Funil de vendas</h1>
        <OpportunityForm operation={operation} onSaved={fetchOpportunities} />
      </div>
      <Tabs value={operation} onValueChange={(v) => setOperation(v as Operation)}>
        <TabsList>
          {OPERATIONS.map((op) => (
            <TabsTrigger key={op} value={op}>
              {OPERATION_LABELS[op]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {!loading && (
        <OpportunityKanban operation={operation} opportunities={opportunities} onChanged={fetchOpportunities} />
      )}
    </div>
  );
}
