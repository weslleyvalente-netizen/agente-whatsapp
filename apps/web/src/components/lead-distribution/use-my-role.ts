"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useOrganization } from "@/providers/organization-provider";

export type RoleStatus = "loading" | "ready" | "error";
interface RoleState { orgId: string | null; userId: string | null; role: string | null; status: RoleStatus }

/** Sem chamadas de rede quando lead_distribution_enabled não é true (a menos que opts.always). Papel do usuário logado na organização atual (owner | admin | agent), lido de organization_members.
 *  status: "loading" enquanto busca (inclusive logo após trocar de organização, sem reaproveitar o papel da anterior); "error" se a busca falhar. */
export function useMyRole(opts: { always?: boolean } = {}): { userId: string | null; role: string | null; status: RoleStatus } {
  const { currentOrg } = useOrganization();
  const enabled = opts.always === true || currentOrg?.settings.lead_distribution_enabled === true;
  const [state, setState] = useState<RoleState>({ orgId: null, userId: null, role: null, status: "loading" });
  useEffect(() => {
    if (!currentOrg || !enabled) return;
    const supabase = createClient();
    let cancelled = false;
    const orgId = currentOrg.id;
    const fail = () => { if (!cancelled) setState({ orgId, userId: null, role: null, status: "error" }); };
    supabase.auth.getUser().then(async ({ data, error: userError }) => {
      if (userError) return fail();
      const uid = data.user?.id ?? null;
      if (!uid) { if (!cancelled) setState({ orgId, userId: null, role: null, status: "ready" }); return; }
      const { data: m, error } = await supabase.from("organization_members").select("role").eq("organization_id", orgId).eq("user_id", uid).maybeSingle();
      if (error) return fail();
      if (!cancelled) setState({ orgId, userId: uid, role: (m?.role as string | undefined) ?? null, status: "ready" });
    }).catch(fail);
    return () => { cancelled = true; };
  }, [currentOrg, enabled]);
  if (!currentOrg || !enabled) return { userId: null, role: null, status: "ready" };
  if (state.orgId !== currentOrg.id) return { userId: null, role: null, status: "loading" };
  return { userId: state.userId, role: state.role, status: state.status };
}
