"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface AssignSelectProps {
  conversationId: string;
  assignedTo: string | null;
  organizationId: string;
  onUpdate: () => void;
}

export function AssignSelect({ conversationId, assignedTo, organizationId, onUpdate }: AssignSelectProps) {
  const [members, setMembers] = useState<Array<{ user_id: string; role: string }>>([]);

  useEffect(() => {
    const fetchMembers = async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("organization_members")
        .select("user_id, role")
        .eq("organization_id", organizationId);
      setMembers(data || []);
    };
    fetchMembers();
  }, [organizationId]);

  const handleAssign = async (userId: string) => {
    const supabase = createClient();
    await supabase
      .from("conversations")
      .update({ assigned_to: userId === "none" ? null : userId })
      .eq("id", conversationId);
    onUpdate();
  };

  return (
    <Select value={assignedTo || "none"} onValueChange={(v) => v && handleAssign(v)}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Atribuir a..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Ninguem</SelectItem>
        {members.map((m) => (
          <SelectItem key={m.user_id} value={m.user_id}>
            {m.user_id.slice(0, 8)}... ({m.role})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
