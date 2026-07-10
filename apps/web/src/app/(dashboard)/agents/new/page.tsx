"use client";

import { useRouter } from "next/navigation";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { AgentForm } from "@/components/agents/agent-form";

export default function NewAgentPage() {
  const router = useRouter();
  const { currentOrg } = useOrganization();

  const handleSubmit = async (values: Record<string, unknown>) => {
    if (!currentOrg) return;
    const supabase = createClient();

    const { error } = await supabase.from("agents").insert({
      ...values,
      organization_id: currentOrg.id,
    });

    if (error) throw error;
    router.push("/agents");
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Novo Agente</h1>
      <AgentForm onSubmit={handleSubmit} submitLabel="Criar Agente" />
    </div>
  );
}
