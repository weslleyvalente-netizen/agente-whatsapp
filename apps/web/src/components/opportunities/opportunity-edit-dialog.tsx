"use client";
import {useEffect,useState} from "react";
import {apiFetch} from "@/lib/api";
import {useOrganization} from "@/providers/organization-provider";
import {resolveOpportunityEditValues,PRODUCT_LABELS,WAITING_ON_LABELS,LEAD_ORIGIN_LABELS,type Opportunity} from "@aula-agente/shared";
import {QualificationSection,type QualificationFieldDescriptor as Field} from "@/components/tasks/qualification-section";
import {Button} from "@/components/ui/button";
import {Dialog,DialogContent,DialogHeader,DialogTitle} from "@/components/ui/dialog";
interface Details {opportunity:Opportunity;conversation:{id:string}|null;qualification:Record<string,unknown>|null;customer:{name:string|null;phone:string};origin:{source:string}|null}
const options=(labels:Record<string,string>)=>Object.entries(labels).map(([value,label])=>({value,label}));
const conditions:Field[]=[
 {key:"product",label:"Tipo do bem",kind:"select",options:options(PRODUCT_LABELS)},
 {key:"product_model",label:"Bem desejado / modelo",kind:"text"},
 ...[["sale_amount","Valor do bem"],["credit_amount","Crédito"],["down_payment_amount","Entrada"],["bid_amount","Lance"],["target_installment_amount","Parcela confortável"]].map(([key,label])=>({key,label,kind:"currency" as const})),
 {key:"term_months",label:"Prazo (meses)",kind:"number"},
 {key:"usage_purpose",label:"Finalidade",kind:"text"},{key:"urgency",label:"Urgência",kind:"text"},{key:"main_objection",label:"Objeção / restrição",kind:"text"},
];
const next:Field[]=[{key:"next_action",label:"Próximo passo",kind:"text"},{key:"next_action_due_date",label:"Prazo",kind:"date"},{key:"waiting_on",label:"Aguardando",kind:"select",options:options(WAITING_ON_LABELS)},{key:"waiting_on_until",label:"Data combinada",kind:"date"},{key:"commercial_notes",label:"Observações",kind:"textarea"}];
const client:Field[]=[{key:"city",label:"Cidade",kind:"text"},{key:"birth_date",label:"Nascimento",kind:"date"},{key:"has_driver_license",label:"Tem CNH?",kind:"boolean"},{key:"driver_license_category",label:"Categoria da CNH",kind:"text"}];
export function OpportunityEditDialog({opportunity,open,onOpenChange,onSaved}:{opportunity:Opportunity;open:boolean;onOpenChange:(open:boolean)=>void;onSaved:()=>void}){
 const {currentOrg}=useOrganization();const [details,setDetails]=useState<Details|null>(null);const [error,setError]=useState<string|null>(null);const [members,setMembers]=useState<{user_id:string;email:string}[]>([]);const [revealed,setRevealed]=useState(false);
 useEffect(()=>{let active=true;setDetails(null);setRevealed(false);setError(null);if(open) apiFetch(`/opportunities/${opportunity.id}/details`).then(d=>{if(active)setDetails(d)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[open,opportunity.id]);
 useEffect(()=>{if(open&&currentOrg)apiFetch(`/organizations/${currentOrg.id}/members/display`).then(setMembers).catch(()=>setMembers([]));},[open,currentOrg]);
 async function reload(){setDetails(await apiFetch(`/opportunities/${opportunity.id}/details${revealed?"?revealCpf=true":""}`));onSaved();}
 async function saveBusiness(patch:Record<string,unknown>){await apiFetch(`/opportunities/${opportunity.id}`,{method:"PATCH",body:JSON.stringify(patch)});await reload();}
 async function saveQualification(patch:Record<string,unknown>){if(!details?.conversation)throw new Error("Sem conversa vinculada");await apiFetch(`/conversations/${details.conversation.id}/qualification`,{method:"PATCH",body:JSON.stringify(patch)});await reload();}
 const values=details?resolveOpportunityEditValues({...details.opportunity},details.qualification):{};
 const divergences=details?conditions.concat(next).filter(f=>details.qualification?.[f.key]!=null && (details.opportunity as unknown as Record<string,unknown>)[f.key]!=null && details.qualification[f.key] !== (details.opportunity as unknown as Record<string,unknown>)[f.key]):[];
 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Editar dados do negócio</DialogTitle></DialogHeader>
 {error&&<p role="alert" className="text-destructive">{error}</p>}{!details?<p>Carregando dados...</p>:<div className="space-y-5">
 <p className="text-sm text-muted-foreground">{details.customer.name} · {details.customer.phone}. Salve cada seção separadamente.</p>
 <p className="text-xs text-muted-foreground">Campos vazios do negócio usam os dados do atendimento. Alterações comerciais são salvas no negócio.</p>
 {divergences.length>0&&<div className="rounded border p-3 text-xs">Valores diferentes no atendimento: {divergences.map(f=>`${f.label}: ${details.qualification?.[f.key]} (o formulário usa o negócio)`).join("; ")}</div>}
 <QualificationSection title="Interesse e condições" fields={conditions} values={values} onSave={saveBusiness} startInEditMode/>
 <QualificationSection title="Próximo passo e observações" fields={next} values={values} onSave={saveBusiness} startInEditMode/>
 <QualificationSection title="Responsável" fields={[{key:"owner_id",label:"Responsável",kind:"select",options:members.map(m=>({value:m.user_id,label:m.email}))}]} values={values} onSave={saveBusiness}/>
 {details.conversation?<><QualificationSection title="Resumo do atendimento" fields={[{key:"summary",label:"Resumo",kind:"textarea"}]} values={details.qualification??{}} onSave={saveQualification} startInEditMode/>
 <QualificationSection title="Dados do cliente" fields={client} values={details.qualification??{}} onSave={saveQualification}/>
 {details.qualification?.has_cpf&&!revealed?<Button variant="outline" onClick={async()=>{try{setDetails(await apiFetch(`/opportunities/${opportunity.id}/details?revealCpf=true`));setRevealed(true);}catch(e){setError((e as Error).message)}}}>Revelar CPF para editar</Button>:<QualificationSection title="CPF" fields={[{key:"cpf",label:"CPF (11 dígitos)",kind:"text"}]} values={details.qualification??{}} onSave={saveQualification}/>}</>:<p className="text-sm">Sem conversa: dados do cliente e resumo ainda não podem ser editados.</p>}
 <QualificationSection title="Origem do lead" fields={[{key:"source",label:"Origem",kind:"select",options:options(LEAD_ORIGIN_LABELS)}]} values={{source:details.origin?.source??null}} onSave={async patch=>{await apiFetch(`/opportunities/${opportunity.id}/origin`,{method:"PATCH",body:JSON.stringify(patch)});await reload()}}/>
 <Button variant="outline" onClick={()=>onOpenChange(false)}>Fechar editor</Button></div>}
 </DialogContent></Dialog>;
}
