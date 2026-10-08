export type LeadVisibility = { mode: "all" } | { mode: "own"; userId: string };

const MANAGER_ROLES = ["owner", "admin"];
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
