"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import type { Organization } from "@aula-agente/shared";

interface OrganizationContextType {
  organizations: Organization[];
  currentOrg: Organization | null;
  setCurrentOrg: (org: Organization) => void;
  loading: boolean;
  refetch: () => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextType>({
  organizations: [],
  currentOrg: null,
  setCurrentOrg: () => {},
  loading: true,
  refetch: async () => {},
});

export function OrganizationProvider({ children }: { children: React.ReactNode }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [currentOrg, setCurrentOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const fetchOrgs = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const loadMemberships = () => supabase
      .from("organization_members")
      .select("organization_id, role, organizations(*)")
      .eq("user_id", user.id);

    let { data: memberships } = await loadMemberships();

    // A person who was invited but has no organization yet joins it now (pending invitation for their e-mail).
    if (!memberships || memberships.length === 0) {
      try {
        const result = await apiFetch("/invitations/accept", { method: "POST" });
        if (result?.accepted > 0) ({ data: memberships } = await loadMemberships());
      } catch {
        // No pending invitation (or the API is unreachable): fall through to the normal onboarding.
      }
    }

    if (memberships && memberships.length > 0) {
      const orgs = memberships
        .map((m) => m.organizations as unknown as Organization)
        .filter(Boolean);
      setOrganizations(orgs);

      // Restore last selected org from localStorage
      const savedOrgId = localStorage.getItem("currentOrgId");
      const savedOrg = orgs.find((o) => o.id === savedOrgId);
      setCurrentOrg(savedOrg || orgs[0]);
    }

    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchOrgs();
  }, [fetchOrgs]);

  const handleSetCurrentOrg = (org: Organization) => {
    setCurrentOrg(org);
    localStorage.setItem("currentOrgId", org.id);
  };

  return (
    <OrganizationContext.Provider
      value={{
        organizations,
        currentOrg,
        setCurrentOrg: handleSetCurrentOrg,
        loading,
        refetch: fetchOrgs,
      }}
    >
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization() {
  return useContext(OrganizationContext);
}
