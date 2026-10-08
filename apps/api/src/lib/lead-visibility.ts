export type LeadVisibility = { mode: "all" } | { mode: "own"; userId: string };

const MANAGER_ROLES = ["owner", "admin"];
/** O filtro por vendedor na API vale quando a distribuição OU o isolamento por vendedor estão ligados na organização. */
export const isSellerFilterEnabled = (settings: { lead_distribution_enabled?: boolean; seller_isolation_enabled?: boolean } | null | undefined): boolean =>
  settings?.lead_distribution_enabled === true || settings?.seller_isolation_enabled === true;
export const isManager = (role: string) => MANAGER_ROLES.includes(role);

export function resolveLeadVisibility(args: { role: string; userId: string; leadDistributionEnabled: boolean }): LeadVisibility {
  if (!args.leadDistributionEnabled || isManager(args.role)) return { mode: "all" };
  return { mode: "own", userId: args.userId };
}

/**
 * Fase 1 (isolamento de aplicação, não do banco): o vendedor deixa de ver apenas o que pertence a OUTRO vendedor.
 * Leads sem dono, ou com dono legado que não é vendedor, seguem visíveis para não perder a carteira atual na ativação.
 */
export function isLeadVisible(visibility: LeadVisibility, ownerUserId: string | null | undefined, repUserIds: Set<string>): boolean {
  if (visibility.mode === "all") return true;
  if (!ownerUserId || ownerUserId === visibility.userId) return true;
  return !repUserIds.has(ownerUserId);
}
