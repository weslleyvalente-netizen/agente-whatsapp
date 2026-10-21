"use client";
import {useOrganization} from '@/providers/organization-provider';
import {ManualFinancingWorkspace} from '@/components/manual-financing/workspace';
export default function FinancingPage(){
  const {currentOrg,loading}=useOrganization();
  if(loading)return <p role="status">Carregando organização…</p>;
  if(!currentOrg)return <p>Selecione uma organização para abrir as consultas.</p>;
  return <ManualFinancingWorkspace key={currentOrg.id} organizationId={currentOrg.id}/>;
}
