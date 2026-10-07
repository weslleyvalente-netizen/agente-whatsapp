"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useOrganization } from "@/providers/organization-provider";

/** Papel do usuário logado na organização atual (owner | admin | agent), lido de organization_members. */
export function useMyRole(): { userId: string | null; role: string | null } {
  const { currentOrg } = useOrganization();
  const [state, setState] = useState<{ userId: string | null; role: string | null }>({ userId: null, role: null });
  useEffect(() => {
    if (!currentOrg) return;
    const supabase = createClient();
    let cancelled = false;
    supabase.auth.getUser().then(async ({ data }) => {
      const uid = data.user?.id ?? null;
      if (!uid) { if (!cancelled) setState({ userId: null, role: null }); return; }
      const { data: m } = await supabase.from("organization_members").select("role").eq("organization_id", currentOrg.id).eq("user_id", uid).maybeSingle();
      if (!cancelled) setState({ userId: uid, role: (m?.role as string | undefined) ?? null });
    });
    return () => { cancelled = true; };
  }, [currentOrg]);
  return state;
}
