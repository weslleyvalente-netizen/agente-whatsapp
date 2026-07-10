"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserCheck, Bot } from "lucide-react";

interface TakeoverBarProps {
  conversationId: string;
  isHumanTakeover: boolean;
  assignedTo: string | null;
  organizationId: string;
  onUpdate: () => void;
}

export function TakeoverBar({
  conversationId,
  isHumanTakeover,
  assignedTo,
  organizationId,
  onUpdate,
}: TakeoverBarProps) {
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

  const handleTakeover = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    await supabase
      .from("conversations")
      .update({
        is_human_takeover: !isHumanTakeover,
        human_takeover_at: !isHumanTakeover ? new Date().toISOString() : null,
        assigned_to: !isHumanTakeover ? user?.id : null,
      })
      .eq("id", conversationId);

    onUpdate();
  };

  const handleAssign = async (userId: string) => {
    const supabase = createClient();
    await supabase
      .from("conversations")
      .update({ assigned_to: userId === "none" ? null : userId })
      .eq("id", conversationId);
    onUpdate();
  };

  return (
    <div className="flex items-center gap-3 rounded-md border bg-muted/50 p-3">
      <Button
        variant={isHumanTakeover ? "default" : "outline"}
        size="sm"
        onClick={handleTakeover}
      >
        {isHumanTakeover ? (
          <>
            <Bot className="mr-2 h-4 w-4" />
            Devolver ao Agente
          </>
        ) : (
          <>
            <UserCheck className="mr-2 h-4 w-4" />
            Assumir Conversa
          </>
        )}
      </Button>

      <Select value={assignedTo || "none"} onValueChange={(v) => v && handleAssign(v)}>
        <SelectTrigger className="w-48">
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
    </div>
  );
}
