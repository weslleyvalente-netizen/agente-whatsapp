"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { useMyRole } from "@/components/lead-distribution/use-my-role";
import { bannerTitle, extraReasons, type HealthState } from "./health-banner-format";

const POLL_MS = 60_000;

/** Faixa vermelha para owner/admin quando o monitor da API detecta silêncio, Redis fora ou WhatsApp desconectado. */
export function HealthBanner() {
  const { currentOrg } = useOrganization();
  const { role } = useMyRole({ always: true });
  const [health, setHealth] = useState<HealthState | null>(null);
  const isManager = role === "owner" || role === "admin";

  useEffect(() => {
    if (!currentOrg || !isManager) { setHealth(null); return; }
    let cancelled = false;
    const load = () => {
      apiFetch(`/organizations/${currentOrg.id}/health`)
        .then((h: HealthState) => { if (!cancelled) setHealth(h); })
        // API fora do ar já é visível por outros meios; não troca o último estado conhecido.
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [currentOrg, isManager]);

  if (!isManager || !health || health.status !== "warning") return null;

  const title = bannerTitle(health);
  const extras = extraReasons(health, title);
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-red-700 bg-red-600 px-3 py-2 text-sm text-white md:px-6">
      <strong>{title}</strong>
      {extras.length > 0 && <span>{extras.join(" · ")}</span>}
      <Link href="/settings#recuperar-mensagens" className="ml-auto font-medium underline underline-offset-2">
        Configurações &rarr; Recuperar mensagens
      </Link>
    </div>
  );
}
