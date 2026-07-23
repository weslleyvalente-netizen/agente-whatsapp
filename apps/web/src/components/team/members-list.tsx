"use client";

import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2 } from "lucide-react";

const ROLE_LABELS: Record<string, string> = { admin: "Admin", agent: "Agente" };

interface Member {
  id: string;
  user_id: string;
  role: string;
  created_at: string;
}

interface MembersListProps {
  members: Member[];
  currentUserId: string;
  currentUserRole: string;
  onRefresh: () => void;
}

export function MembersList({ members, currentUserId, currentUserRole, onRefresh }: MembersListProps) {
  const canManage = currentUserRole === "owner" || currentUserRole === "admin";

  const handleRoleChange = async (memberId: string, newRole: string) => {
    const supabase = createClient();
    await supabase
      .from("organization_members")
      .update({ role: newRole })
      .eq("id", memberId);
    onRefresh();
  };

  const handleRemove = async (memberId: string) => {
    if (!confirm("Remover este membro?")) return;
    const supabase = createClient();
    await supabase.from("organization_members").delete().eq("id", memberId);
    onRefresh();
  };

  return (
    <div className="space-y-2">
      {members.map((member) => {
        const isCurrentUser = member.user_id === currentUserId;
        const isOwner = member.role === "owner";

        return (
          <div key={member.id} className="flex items-center justify-between rounded-md border p-3">
            <div className="flex items-center gap-3">
              <Avatar className="h-8 w-8">
                <AvatarFallback>{member.user_id.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium">
                  {member.user_id.slice(0, 8)}...
                  {isCurrentUser && " (voce)"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Desde {new Date(member.created_at).toLocaleDateString("pt-BR")}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {canManage && !isOwner && !isCurrentUser ? (
                <>
                  <Select value={member.role} onValueChange={(v) => v && handleRoleChange(member.id, v)}>
                    <SelectTrigger className="w-28 h-8">
                      <SelectValue>{(value: string) => ROLE_LABELS[value] ?? value}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="agent">Agente</SelectItem>
                    </SelectContent>
                  </Select>
                  {currentUserRole === "owner" && (
                    <Button variant="ghost" size="icon" onClick={() => handleRemove(member.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </>
              ) : (
                <Badge variant={isOwner ? "default" : "secondary"}>{member.role}</Badge>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
