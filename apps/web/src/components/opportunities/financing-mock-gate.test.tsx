import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const org = vi.hoisted(() => ({ current: null as null | { id: string; settings: Record<string, unknown> } }));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/providers/organization-provider", () => ({
  useOrganization: () => ({ currentOrg: org.current, loading: false }),
}));
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("./financing-alerts-panel", () => ({ FinancingAlertsPanel: () => <p>PAINEL-ALERTAS</p> }));
vi.mock("@/components/manual-financing/workspace", () => ({ ManualFinancingWorkspace: () => <p>WORKSPACE-MANUAL</p> }));
vi.mock("@/components/financing/workspace", () => ({ FinancingWorkspace: () => <p>WORKSPACE-TESTE</p> }));

import { FinancingHistory } from "./financing-history";
import { FinancingAlerts } from "./financing-alerts";
import FinancingManualPage from "@/app/(dashboard)/financiamento/page";
import FinancingCrmPage from "@/app/(dashboard)/financiamento/crm/page";

const setOrg = (settings: Record<string, unknown> | null) => { org.current = settings ? { id: "org-1", settings } : null; };
const DISABLED: Array<[string, Record<string, unknown> | null]> = [
  ["sem organização", null], ["chave ausente", {}], ["false", { financing_mock_enabled: false }], ["valor não-true", { financing_mock_enabled: "true" }],
];

beforeEach(() => { apiFetch.mockReset(); setOrg({}); });

describe.each(DISABLED)("financiamento de testes desativado (%s)", (_l, settings) => {
  beforeEach(() => setOrg(settings));

  it("detalhe da oportunidade: nenhum bloco de histórico e nenhuma chamada à API", () => {
    expect(renderToStaticMarkup(<FinancingHistory opportunityId="opp-1" />)).toBe("");
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it("notificações: não monta o painel de alertas (sem /financing/alerts nem polling)", () => {
    expect(renderToStaticMarkup(<FinancingAlerts />)).toBe("");
  });
  it("página /financiamento/crm: não monta o workspace de testes e avisa que está desativado", () => {
    if (!settings) return;
    const out = renderToStaticMarkup(<FinancingCrmPage />);
    expect(out).not.toContain("WORKSPACE-TESTE");
    expect(out).toContain("financiamento de testes está desativado");
    expect(out).toContain("financiamento manual segue disponível");
  });
});

describe("financiamento de testes ativado (financing_mock_enabled = true)", () => {
  beforeEach(() => setOrg({ financing_mock_enabled: true }));

  it("detalhe: monta o painel real (que consulta a API e continua exibindo erros reais)", () => {
    expect(renderToStaticMarkup(<FinancingHistory opportunityId="opp-1" />)).toContain("Carregando histórico…");
  });
  it("notificações: monta o painel de alertas", () => {
    expect(renderToStaticMarkup(<FinancingAlerts />)).toContain("PAINEL-ALERTAS");
  });
  it("página /financiamento/crm: monta o workspace de testes", () => {
    expect(renderToStaticMarkup(<FinancingCrmPage />)).toContain("WORKSPACE-TESTE");
  });
});

describe("financiamento manual (independente da chave de testes)", () => {
  it.each([[{}], [{ financing_mock_enabled: false }], [{ financing_mock_enabled: true }]])("/financiamento continua montando o workspace manual (%j)", (settings) => {
    setOrg(settings);
    expect(renderToStaticMarkup(<FinancingManualPage />)).toContain("WORKSPACE-MANUAL");
  });
});
