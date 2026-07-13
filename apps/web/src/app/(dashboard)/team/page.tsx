"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { MembersList } from "@/components/team/members-list";
import { InviteDialog } from "@/components/team/invite-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function TeamPage() {
  const { currentOrg } = useOrganization();
  const [members, setMembers] = useState<any[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [currentUserRole, setCurrentUserRole] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!currentOrg) return;
    const supabase = createClient();

    const { data: { user } } = await supabase.auth.getUser();
    setCurrentUserId(user!.id);

    const [membersResult, invitationsResult] = await Promise.all([
      supabase
        .from("organization_members")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at"),
      supabase
        .from("organization_invitations")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
    ]);

    const membersList = membersResult.data || [];
    setMembers(membersList);
    setInvitations(invitationsResult.data || []);

    const myMembership = membersList.find((m: any) => m.user_id === user!.id);
    setCurrentUserRole(myMembership?.role || "agent");

    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Equipe</h1>
        {(currentUserRole === "owner" || currentUserRole === "admin") && (
          <InviteDialog onInvited={fetchData} />
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Membros ({members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <MembersList
            members={members}
            currentUserId={currentUserId}
            currentUserRole={currentUserRole}
            onRefresh={fetchData}
          />
        </CardContent>
      </Card>

      {invitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Convites Pendentes ({invitations.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {invitations.map((inv: any) => (
                <div key={inv.id} className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="text-sm">{inv.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Expira em {new Date(inv.expires_at).toLocaleDateString("pt-BR")}
                    </p>
                  </div>
                  <Badge variant="secondary">{inv.role}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
