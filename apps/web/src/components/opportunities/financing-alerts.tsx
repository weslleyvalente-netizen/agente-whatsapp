"use client";
import { useOrganization } from '@/providers/organization-provider';
import { isFinancingMockEnabled } from '@/lib/financing-mock';
import { FinancingAlertsPanel } from './financing-alerts-panel';

/** Com o financiamento de testes desativado (padrão) não monta o painel: sem chamada a /financing/alerts e sem polling de 30 s. */
export function FinancingAlerts(){
  const {currentOrg}=useOrganization();
  if(!isFinancingMockEnabled(currentOrg?.settings))return null;
  return <FinancingAlertsPanel/>;
}
