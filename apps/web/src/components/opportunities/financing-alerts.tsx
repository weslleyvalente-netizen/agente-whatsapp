"use client";
import { useEffect, useState } from 'react';
import { FinancingHistory } from './financing-history';
import { useOrganization } from '@/providers/organization-provider';
import { apiFetch } from '@/lib/api';
type Alert={request_id:string;opportunity_id:string;created_at:string;opportunities:{wa_contacts:{name:string|null}|null}};
export function FinancingAlerts(){
  const {currentOrg}=useOrganization();const [alerts,setAlerts]=useState<Alert[]>([]);const [selected,setSelected]=useState<string|null>(null);
  useEffect(()=>{
    setAlerts([]);setSelected(null);
    if(!currentOrg)return;let active=true;
    const load=()=>apiFetch(`/organizations/${currentOrg.id}/financing/alerts`).then(data=>{if(active)setAlerts(data.alerts);}).catch(()=>{if(active)setAlerts([]);});
    void load();const timer=setInterval(load,30_000);return()=>{active=false;clearInterval(timer);};
  },[currentOrg]);
  if(!alerts.length)return null;
  return <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">Resultados de financiamento</h2>
    <p className="text-sm text-muted-foreground">Ambiente de testes. Resultados disponíveis somente para o vendedor responsável e gestores.</p>
    {alerts.map(a=><div key={a.request_id} role="status"><button className="text-left underline" onClick={()=>setSelected(selected===a.opportunity_id?null:a.opportunity_id)}>Consulta concluída — {a.opportunities.wa_contacts?.name || 'Cliente atribuído'}</button><p className="text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString('pt-BR')}</p></div>)}
    {selected&&<FinancingHistory opportunityId={selected}/>}
  </section>;
}
