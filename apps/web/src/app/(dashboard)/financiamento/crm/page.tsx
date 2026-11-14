"use client";
import {useOrganization} from '@/providers/organization-provider';
import {FinancingWorkspace} from '@/components/financing/workspace';
import {isFinancingMockEnabled} from '@/lib/financing-mock';
export default function FinancingPage(){
  const {currentOrg,loading}=useOrganization();
  if(loading)return <p role="status">Carregando organização…</p>;
  if(!currentOrg)return <p>Selecione uma organização para abrir as consultas.</p>;
  if(!isFinancingMockEnabled(currentOrg.settings))return <p role="status">O financiamento de testes está desativado nesta organização. O financiamento manual segue disponível em Financiamento.</p>;
  return <FinancingWorkspace key={currentOrg.id} organizationId={currentOrg.id}/>;
}
