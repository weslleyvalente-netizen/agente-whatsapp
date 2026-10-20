"use client";
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
type Result = {bank:string;status:string;offers:{downPayment:number;installments:number;installmentAmount:number}[]};
type Request = {id:string;mode:string;attempt:number;state:string;created_at:string;requery_on:string|null;financing_results:Result[]};
const labels:Record<string,string>={pending:'Aguardando',preapproved:'Pré-aprovado',rejected:'Recusado',simulation:'Simulação sem aprovação',error:'Erro técnico',queued:'Na fila',running:'Em consulta',completed:'Concluído',cancelled:'Cancelado'};
const bankLabels:Record<string,string>={'mock-approved':'Banco de teste A','mock-rejected':'Banco de teste B','mock-error':'Banco de teste C','mock-simulation':'Banco de teste D'};
const money=(n:number)=>n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
export function FinancingHistory({opportunityId}:{opportunityId:string}) {
  const [rows,setRows]=useState<Request[]>([]);
  const [message,setMessage]=useState('');
  const [loading,setLoading]=useState(true),[error,setError]=useState(false),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    setRows([]);setLoading(true);setError(false);
    let active=true;
    const load=()=>apiFetch(`/opportunities/${opportunityId}/financing`).then(data=>{if(active){setRows(data.requests);setError(false);setLoading(false);}}).catch(()=>{if(active){setRows([]);setError(true);setLoading(false);}});
    void load();const timer=setInterval(load,30_000);
    return ()=>{active=false;clearInterval(timer);};
  },[opportunityId,refresh]);
  if(loading)return <p role="status" className="text-sm">Carregando histórico…</p>;
  if(error)return <p role="alert" className="text-sm">Histórico indisponível. A atualização será tentada novamente em 30 segundos.</p>;
  if(!rows.length)return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Este cliente ainda não tem consultas registradas.</p>;
  async function cancel(){
    try{await apiFetch(`/opportunities/${opportunityId}/financing/cancel`,{method:'POST'});setMessage('Autorização revogada e reconsultas canceladas.');setRows(current=>current.map(row=>({...row,requery_on:null})));setRefresh(current=>current+1);}
    catch{setMessage('Não foi possível cancelar. Tente novamente.');}
  }
  return <section className="rounded-lg border p-4" aria-label="Resultados de financiamento">
    <h3 className="font-medium">Financiamento — alerta interno</h3>
    <p className="text-sm text-muted-foreground">Ambiente de testes. Propostas fictícias. Nenhuma mensagem é enviada ao cliente.</p>
    {rows.map(r=><div key={r.id} className="mt-3 border-t pt-3">
      <p>{r.attempt===1?'Reconsulta única':'Primeira consulta'} · {labels[r.state]??r.state}</p>
      {r.requery_on&&<p className="text-sm">Reconsulta autorizada para {r.requery_on.split('-').reverse().join('/')}</p>}
      {r.financing_results.map(b=><div key={b.bank} className="mt-2 text-sm" role="status">
        <strong>{bankLabels[b.bank]??b.bank} · {labels[b.status]??b.status}</strong>
        {b.offers.map((offer,i)=><p key={i}>Entrada {money(offer.downPayment)} + {offer.installments}x de {money(offer.installmentAmount)}</p>)}
      </div>)}
    </div>)}
    <Button className="mt-3" variant="outline" onClick={cancel}>Revogar autorização / desinteresse</Button>
    {message&&<p role="status">{message}</p>}
  </section>;
}
