"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
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
    };
    fetchMembers();
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null));
  }, [organizationId]);

  const handleAssign = async (userId: string) => {
    const supabase = createClient();
    setError(null);
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

  const memberLabel = (userId: string) => {
    if (userId === currentUserId) return "Com você";
    const member = members.find((m) => m.user_id === userId);
    return member ? `${member.user_id.slice(0, 8)}... (${member.role})` : userId;
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
            {m.user_id === currentUserId ? "Você" : `${m.user_id.slice(0, 8)}... (${m.role})`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
