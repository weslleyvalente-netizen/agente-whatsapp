"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useMyRole } from "@/components/lead-distribution/use-my-role";
import { guardDecision } from "@/lib/route-access";

/** Impede o vendedor de abrir telas de gestão (e não pisca conteúdo restrito enquanto o papel carrega). */
export function RouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { role, status } = useMyRole({ always: true });
  const decision = guardDecision(pathname, role, status);

  useEffect(() => {
    if (decision.kind === "redirect") router.replace(decision.to);
  }, [decision.kind, decision.kind === "redirect" ? decision.to : null, router]); // eslint-disable-line react-hooks/exhaustive-deps

  if (decision.kind !== "allow") return <div className="text-sm text-muted-foreground">Carregando...</div>;
  return <>{children}</>;
}
