"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { useMyRole } from "@/components/lead-distribution/use-my-role";
import { shouldUseManualAssign } from "@/lib/lead-assign";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface AssignSelectProps {
  conversationId: string;
  assignedTo: string | null;
  organizationId: string;
  onUpdate: () => void;
  triggerClassName?: string;
}

export function AssignSelect({
  conversationId,
  assignedTo,
  organizationId,
  onUpdate,
  triggerClassName = "w-full",
}: AssignSelectProps) {
  const [members, setMembers] = useState<Array<{ user_id: string; role: string }>>([]);
  const [repNames, setRepNames] = useState<Record<string, string>>({});
  const [repIds, setRepIds] = useState<Record<string, string>>({});
  const { currentOrg } = useOrganization();
  const { role } = useMyRole();
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const fetchMembers = async () => {
      const { data } = await supabase
        .from("organization_members")
        .select("user_id, role")
        .eq("organization_id", organizationId);
      setMembers(data || []);
      const { data: reps } = await supabase.from("sales_reps").select("id, user_id, display_name").eq("organization_id", organizationId);
      setRepNames(Object.fromEntries((reps ?? []).map((r: { user_id: string; display_name: string }) => [r.user_id, r.display_name])));
      setRepIds(Object.fromEntries((reps ?? []).map((r: { id: string; user_id: string }) => [r.user_id, r.id])));
    };
    fetchMembers();
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null));
  }, [organizationId]);

  const handleAssign = async (userId: string) => {
    const supabase = createClient();
    setError(null);
    const targetRepId = userId === "none" ? null : repIds[userId] ?? null;
    if (shouldUseManualAssign({ distributionOn: currentOrg?.settings.lead_distribution_enabled === true, role, targetRepId })) {
      // Reatribuição do rodízio: grava o histórico, inicia o prazo de resposta e avisa o vendedor. O banco move conversa, negócio e tarefas.
      try {
        await apiFetch(`/organizations/${organizationId}/lead-assignments/manual`, { method: "POST", body: JSON.stringify({ conversationId, repId: targetRepId }) });
      } catch (err) {
        setError((err as { message?: string }).message ?? "Não foi possível reatribuir o lead.");
      }
      onUpdate();
      return;
    }
    // select() permite detectar 0 linhas: com o isolamento por vendedor o banco ignora (sem erro) a conversa que o usuário não vê.
    const { data, error: updateError } = await supabase
      .from("conversations")
      .update({ assigned_to: userId === "none" ? null : userId })
      .eq("id", conversationId)
      .select("id");
    if (updateError || !data || data.length === 0) {
      setError("Não foi possível atribuir a conversa. Somente o gestor passa uma conversa para outro vendedor.");
    }
    onUpdate();
  };

  const ROLE_LABELS: Record<string, string> = { owner: "Gestor", admin: "Administrador", agent: "Atendente" };
  // Vendedores aparecem pelo nome cadastrado; os demais pelo papel (com o fim do código só se houver nomes repetidos).
  const nameOf = (m: { user_id: string; role: string }) => {
    if (repNames[m.user_id]) return repNames[m.user_id];
    const base = ROLE_LABELS[m.role] ?? m.role;
    const repeated = members.filter(x => !repNames[x.user_id] && (ROLE_LABELS[x.role] ?? x.role) === base).length > 1;
    return repeated ? `${base} (${m.user_id.slice(0, 4)})` : base;
  };
  const memberLabel = (userId: string) => {
    if (userId === currentUserId) return repNames[userId] ? `${repNames[userId]} (você)` : "Com você";
    const member = members.find((m) => m.user_id === userId);
    return member ? nameOf(member) : "Responsável";
  };

  return (
    <div className="space-y-1">
    <Select value={assignedTo || "none"} onValueChange={(v) => v && handleAssign(v)}>
      <SelectTrigger className={triggerClassName}>
        <SelectValue placeholder="Atribuir a...">
          {(value: string) => (value === "none" ? "Ninguem" : memberLabel(value))}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Ninguem</SelectItem>
        {members.map((m) => (
          <SelectItem key={m.user_id} value={m.user_id}>
            {m.user_id === currentUserId ? (repNames[m.user_id] ? `${repNames[m.user_id]} (você)` : "Você") : nameOf(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
