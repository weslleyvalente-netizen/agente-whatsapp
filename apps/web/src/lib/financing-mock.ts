import type { OrganizationSettings } from "@aula-agente/shared";

/**
 * Financiamento de TESTES (propostas fictícias; tabelas financing_*): ativação explícita, somente `true` liga.
 * Não confundir com o financiamento manual (CredPro), que não depende desta chave.
 */
export function isFinancingMockEnabled(settings: Pick<OrganizationSettings, "financing_mock_enabled"> | null | undefined): boolean {
  return settings?.financing_mock_enabled === true;
}
