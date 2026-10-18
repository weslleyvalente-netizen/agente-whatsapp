/** Papéis com acesso às telas de configuração (o banco e a API usam o mesmo critério: owner/admin). */
export const MANAGER_ROLES = ["owner", "admin"] as const;
export const SELLER_HOME = "/inbox";

/** Telas que o vendedor (papel `agent`) não pode abrir. */
export const MANAGER_ONLY_PREFIXES = ["/agents", "/instances", "/costs", "/team", "/settings", "/calls"] as const;

export const isManagerRole = (role: string | null | undefined): boolean => role === "owner" || role === "admin";

export const isManagerOnlyPath = (pathname: string): boolean =>
  MANAGER_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export type GuardDecision = { kind: "allow" } | { kind: "wait" } | { kind: "redirect"; to: string };

/** role === null significa "ainda carregando": nada restrito aparece até saber o papel. */
export function guardDecision(pathname: string, role: string | null): GuardDecision {
  if (!isManagerOnlyPath(pathname)) return { kind: "allow" };
  if (role === null) return { kind: "wait" };
  return isManagerRole(role) ? { kind: "allow" } : { kind: "redirect", to: SELLER_HOME };
}
