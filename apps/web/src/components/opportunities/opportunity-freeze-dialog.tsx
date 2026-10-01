"use client";
import {useState} from "react";
import {apiFetch} from "@/lib/api";
import {toISODateInTimeZone,isValidFreezeDate,type Opportunity} from "@aula-agente/shared";
import {Dialog,DialogContent,DialogHeader,DialogTitle} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
export function OpportunityFreezeDialog({opportunity,onClose,onSaved}:{opportunity:Opportunity;onClose:()=>void;onSaved:()=>void}){
 const thaw=!!opportunity.frozen_until;const [date,setDate]=useState(opportunity.frozen_until??"");const [reason,setReason]=useState("");const [saving,setSaving]=useState(false);const [error,setError]=useState<string|null>(null);
 async function save(remove:boolean){if(saving)return;setSaving(true);setError(null);try{await apiFetch(`/opportunities/${opportunity.id}/freeze`,{method:"POST",body:JSON.stringify({date:remove?null:date,reason:reason.trim()})});onSaved();onClose();}catch(e){setError((e as Error).message)}finally{setSaving(false)}}
 return <Dialog open onOpenChange={open=>{if(!open&&!saving)onClose()}}><DialogContent><DialogHeader><DialogTitle>{thaw?"Reagendar ou descongelar":"Congelar negócio"}</DialogTitle></DialogHeader>
 <label className="text-sm">Data de retorno<Input type="date" value={date} onChange={e=>setDate(e.target.value)} disabled={saving}/></label>
 <label className="text-sm">Motivo<Textarea value={reason} onChange={e=>setReason(e.target.value)} disabled={saving}/></label>
 <p className="text-sm text-muted-foreground">Uma tarefa de retorno será criada ou reagendada. Nenhuma mensagem será enviada automaticamente nessa data. As outras pendências serão preservadas.</p>
 {error&&<p role="alert" className="text-destructive">{error}</p>}
 <Button disabled={saving||!reason.trim()||!isValidFreezeDate(date,toISODateInTimeZone(new Date()))} onClick={()=>save(false)}>{saving?"Salvando...":thaw?"Reagendar retorno":"Congelar e criar retorno"}</Button>
 {thaw&&<Button variant="outline" disabled={saving||!reason.trim()} onClick={()=>save(true)}>Descongelar agora</Button>}
 </DialogContent></Dialog>;
}
