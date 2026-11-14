"use client";
import { useOrganization } from '@/providers/organization-provider';
import { isFinancingMockEnabled } from '@/lib/financing-mock';
import { FinancingHistoryPanel } from './financing-history-panel';

/** Com o financiamento de testes desativado (padrão) não monta o painel: sem bloco, sem chamada à API e sem polling de 30 s. */
export function FinancingHistory({opportunityId}:{opportunityId:string}) {
  const {currentOrg}=useOrganization();
  if(!isFinancingMockEnabled(currentOrg?.settings))return null;
  return <FinancingHistoryPanel opportunityId={opportunityId}/>;
}
