"use client";
import {useEffect,useRef,useState,type FormEvent} from 'react';
import Link from 'next/link';
import {apiFetch} from '@/lib/api';
import {Button} from '@/components/ui/button';
import {FinancingHistory} from '@/components/opportunities/financing-history';
import {createMockSubmission} from './submission';
import {pendingStore} from './pending';

type Opportunity={id:string;operation:string;owner_id:string;wa_contacts:{name:string|null}|null};
type Vehicle={id:number;marca:string;modelo:string;ano:number;preco:number;tipo:string};
type Workspace={userId:string;mode:'mock'|'disabled';inventoryAvailable:boolean;opportunities:Opportunity[];vehicles:Vehicle[];hasMore?:boolean;vehiclesHasMore?:boolean};
const banks=[{id:'mock-approved',name:'Banco de teste A — pré-aprovação'},{id:'mock-rejected',name:'Banco de teste B — recusa'},{id:'mock-error',name:'Banco de teste C — falha técnica'},{id:'mock-simulation',name:'Banco de teste D — simulação'}];
const field='mt-1 min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60';
const money=(n:number)=>n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});

export function FinancingWorkspace({organizationId}:{organizationId:string}){
  const [workspace,setWorkspace]=useState<Workspace|null>(null),[loadError,setLoadError]=useState('');
  const [reload,setReload]=useState(0),[opportunityId,setOpportunityId]=useState(''),[vehicleId,setVehicleId]=useState('');
  const [evidence,setEvidence]=useState(''),[expires,setExpires]=useState(''),[confirmed,setConfirmed]=useState(false),[allowRequery,setAllowRequery]=useState(false);
  const [recoveryBlocked,setRecoveryBlocked]=useState(false);
  const [selectedBanks,setSelectedBanks]=useState<string[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false),[historyVersion,setHistoryVersion]=useState(0);
  const submission=useRef<ReturnType<typeof createMockSubmission>|null>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;submission.current?.cancel();};},[]);
  useEffect(()=>{
    let active=true;setWorkspace(null);setLoadError('');
    apiFetch(`/organizations/${organizationId}/financing/workspace`).then(data=>{if(active)setWorkspace(data);}).catch(()=>{if(active)setLoadError('Não foi possível carregar a área de consulta. Tente atualizar.');});
    return()=>{active=false;};
  },[organizationId,reload]);
  const vehicle=workspace?.vehicles.find(v=>String(v.id)===vehicleId);
  const locked=busy||failed;
  function changeOpportunity(id:string){
    submission.current?.cancel();submission.current=null;setOpportunityId(id);setEvidence('');setExpires('');setConfirmed(false);setAllowRequery(false);setSelectedBanks([]);setVehicleId('');setMessage('');setFailed(false);setRecoveryBlocked(false);
    if(!id||!workspace)return;
    try{
      const store=pendingStore(sessionStorage,workspace.userId,organizationId,id),pending=store.load();
      if(pending){
        setVehicleId(String(pending.vehicleId));setFailed(true);setMessage('Há uma tentativa pendente deste cliente. Retome para verificar se ela já foi registrada.');
        submission.current=createMockSubmission({opportunityId:id,vehicleId:pending.vehicleId,evidence:'',expiresAt:'',banks:[],allowRequery:false},apiFetch,undefined,{...store,pending});
      }
    }catch{setRecoveryBlocked(true);setMessage('Não foi possível recuperar a referência da tentativa neste navegador. Verifique o histórico e habilite o armazenamento da sessão antes de consultar.');}
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(busy||recoveryBlocked||!workspace||workspace.mode!=='mock')return;
    if(!submission.current){
      const date=new Date(expires);
      if(!opportunityId||!vehicle||!confirmed||!selectedBanks.length||evidence.trim().length<10||!Number.isFinite(date.getTime())||date.getTime()<=Date.now()){
        setMessage('Selecione cliente, veículo e bancos de teste. Informe a evidência e uma validade futura para a autorização.');return;
      }
      try{
        const store=pendingStore(sessionStorage,workspace.userId,organizationId,opportunityId);
        submission.current=createMockSubmission({opportunityId,vehicleId:vehicle.id,evidence:evidence.trim(),expiresAt:date.toISOString(),banks:selectedBanks,allowRequery},apiFetch,undefined,store);
      }catch{setMessage('O armazenamento da sessão está indisponível. Habilite-o para preservar a referência da consulta.');return;}
    }
    setBusy(true);setMessage('');
    try{
      await submission.current.run();if(!alive.current)return;
      submission.current=null;setFailed(false);setEvidence('');setExpires('');setConfirmed(false);setAllowRequery(false);setSelectedBanks([]);setHistoryVersion(v=>v+1);
      setMessage('Consulta de teste registrada. Acompanhe o processamento no histórico. Nenhuma mensagem foi enviada ao cliente.');
    }catch(error){if(alive.current){setFailed(true);setMessage(error instanceof Error?error.message:'Não foi possível registrar a consulta.');}}
    finally{if(alive.current)setBusy(false);}
  }
  async function discard(){
    if(!workspace||busy)return;
    setBusy(true);
    try{
      await apiFetch(`/opportunities/${opportunityId}/financing/cancel`,{method:'POST'});
      pendingStore(sessionStorage,workspace.userId,organizationId,opportunityId).clear();
      if(!alive.current)return;
      changeOpportunity(opportunityId);setHistoryVersion(v=>v+1);setMessage('Autorização revogada. A tentativa pendente e as reconsultas foram canceladas.');
    }catch{if(alive.current)setMessage('Não foi possível revogar e descartar a tentativa. Verifique o histórico antes de preparar outra.');}
    finally{if(alive.current)setBusy(false);}
  }
  if(loadError)return <div role="alert" className="space-y-3"><p>{loadError}</p><Button variant="outline" onClick={()=>setReload(v=>v+1)}>Atualizar área de consulta</Button></div>;
  if(!workspace)return <p role="status">Carregando a área de consulta…</p>;
  return <div className="space-y-6">
    <header><h1 className="text-2xl font-semibold tracking-tight">Consulta de financiamento</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Prepare a ficha do veículo e acompanhe as respostas vinculadas ao cliente.</p></header>
    <aside className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm" role="note"><strong>Ambiente de testes</strong><p className="mt-1">As respostas desta tela são fictícias. Consultas reais estão desativadas. Nenhuma mensagem é enviada automaticamente ao cliente.</p></aside>
    {workspace.mode==='disabled'&&<p role="status" className="rounded-lg border p-4">Novas consultas estão desativadas. O histórico continua disponível. Solicite ao administrador a configuração do ambiente de testes.</p>}
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="min-w-0 space-y-5 rounded-xl border bg-card p-4 md:p-6" aria-label="Preparar consulta">
        <h2 className="text-lg font-medium">Cliente e veículo</h2>
        <label className="block text-sm font-medium">Cliente / negócio<select className={field} value={opportunityId} disabled={busy} onChange={e=>changeOpportunity(e.target.value)}><option value="">Selecione um negócio aberto</option>{workspace.opportunities.map(o=><option key={o.id} value={o.id}>{o.wa_contacts?.name||'Cliente sem nome'} · {o.operation==='financing'?'Financiamento':'Veículo'} · {o.id.slice(-6)}</option>)}</select></label>
        <p className="text-sm text-muted-foreground">Vendedores veem seus negócios abertos. Gestores veem os negócios atribuídos da equipe.</p>
        {!workspace.opportunities.length&&<p>Nenhum negócio disponível. Cadastre ou atribua o cliente no <Link className="underline" href="/opportunities">funil de vendas</Link>.</p>}
        {workspace.hasMore&&<p className="text-sm">Exibindo os 500 negócios mais recentes.</p>}
        {workspace.mode==='mock'&&<form className="space-y-5" onSubmit={submit}>
          <label className="block text-sm font-medium">Veículo do estoque<select className={field} required value={vehicleId} disabled={locked||!workspace.inventoryAvailable} onChange={e=>setVehicleId(e.target.value)}><option value="">Selecione o veículo</option>{workspace.vehicles.map(v=><option key={v.id} value={v.id}>{v.marca} {v.modelo} · {v.ano} · #{v.id}</option>)}</select></label>
          {!workspace.inventoryAvailable?<p role="status" className="text-sm">O estoque interno está indisponível ou ainda não foi configurado. Solicite a verificação ao administrador.</p>:!workspace.vehicles.length?<p className="text-sm">Nenhum veículo disponível no estoque.</p>:null}
          {workspace.vehiclesHasMore&&<p className="text-sm">Exibindo os primeiros 500 veículos por modelo.</p>}
          {vehicle&&<p className="rounded-md bg-muted p-3 text-sm"><strong>{vehicle.marca} {vehicle.modelo}</strong><br/>{vehicle.ano} · {money(vehicle.preco)}<br/>A ficha usa os dados do cliente já registrados na qualificação.</p>}
          <fieldset disabled={locked} className="space-y-3"><legend className="mb-2 text-sm font-medium">Bancos de teste</legend>{banks.map(bank=><label className="flex min-h-9 items-center gap-3 text-sm" key={bank.id}><input type="checkbox" className="size-4 shrink-0" checked={selectedBanks.includes(bank.id)} onChange={e=>setSelectedBanks(current=>e.target.checked?[...current,bank.id]:current.filter(id=>id!==bank.id))}/>{bank.name}</label>)}</fieldset>
          <fieldset disabled={locked} className="space-y-4 border-t pt-4"><legend className="text-lg font-medium">Autorização do cliente</legend>
            <label className="block text-sm font-medium">Onde a autorização foi registrada<textarea className={field} required minLength={10} maxLength={2000} rows={3} value={evidence} onChange={e=>setEvidence(e.target.value)} placeholder="Ex.: autorização no atendimento de hoje, com identificação da mensagem."/></label>
            <p className="text-sm text-muted-foreground">Registre a referência da autorização. CPF e nascimento devem estar completos na qualificação do cliente no funil.</p>
            <label className="block text-sm font-medium">Válida até<input className={field} type="datetime-local" required value={expires} onInput={e=>setExpires(e.currentTarget.value)} onChange={e=>setExpires(e.target.value)}/></label>
            <label className="flex items-start gap-3 text-sm"><input className="mt-1 size-4 shrink-0" type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Confirmo que a autorização cobre os bancos selecionados e a validade informada.</label>
            <label className="flex items-start gap-3 text-sm"><input className="mt-1 size-4 shrink-0" type="checkbox" checked={allowRequery} onChange={e=>setAllowRequery(e.target.checked)}/>A autorização também permite uma única reconsulta no último dia útil, conforme as regras aplicáveis.</label>
          </fieldset>
          {failed&&<div className="space-y-3"><p className="text-sm">Ao tentar novamente, a mesma solicitação será retomada para evitar duplicidade.</p><Button type="button" variant="outline" className="min-h-11 w-full whitespace-normal" disabled={busy} onClick={discard}>Revogar autorização e descartar tentativa</Button></div>}
          <Button className="min-h-11 w-full" type="submit" disabled={busy||recoveryBlocked||!opportunityId||(!failed&&(!workspace.inventoryAvailable||!vehicle||!confirmed||!selectedBanks.length))}>{busy?'Registrando consulta…':failed?'Retomar mesma consulta de teste':'Consultar em teste'}</Button>
        </form>}
        {message&&<p className="text-sm" role={failed?'alert':'status'}>{message}</p>}
        <Link className="inline-block text-sm underline underline-offset-4" href="/opportunities">Abrir funil e completar cadastro</Link>
      </section>
      <section className="min-w-0 space-y-4" aria-label="Acompanhamento"><div><h2 className="text-lg font-medium">Histórico e resultados</h2><p className="mt-1 text-sm text-muted-foreground">Respostas por banco, entradas e parcelas quando retornadas. Atualização a cada 30 segundos.</p></div>{opportunityId?<FinancingHistory key={`${opportunityId}:${historyVersion}`} opportunityId={opportunityId}/>:<p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">Selecione um cliente para consultar o histórico.</p>}</section>
    </div>
  </div>;
}
