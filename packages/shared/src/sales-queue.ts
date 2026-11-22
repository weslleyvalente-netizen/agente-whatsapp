export interface SalesQueueInput {id:string;created_at:string;status:string;stage:string;waiting_on:string|null;next_action_due_date:string|null;frozen_until?:string|null;last_interaction_at?:string|null;sales_state?:{readyForHuman:boolean;customerReplied:boolean;humanPending:boolean;taskCount:number;hot?:boolean;urgent?:UrgentState|null};tasks?:Array<{type:string;due_date:string;priority:string;consolidated_pendencies?:Array<{type:string;due_date:string;priority:string}>}>;}
export const SALES_QUEUE_LABELS = {ready:'Pronto para assumir',customer_replied:'Cliente respondeu',due_today:'Compromissos de hoje',overdue:'Pendências com interesse',action:'Próximas ações',scheduled:'Retornos futuros',waiting:'Aguardando cliente ou banco',no_response:'Sem resposta',other:'Outros'} as const;
export type SalesQueueGroup=keyof typeof SALES_QUEUE_LABELS;
export function classifySalesQueue(row:SalesQueueInput,now:string){
 const today=new Date(now).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
 const tasks=(row.tasks??[]).flatMap(t=>t.consolidated_pendencies?.length?t.consolidated_pendencies:[t]);
 let group:SalesQueueGroup='other';
 if(row.status!=='open')group='other';
 // Urgente = cliente esperando a loja (prazo vencido, ninguém respondeu, promessa vencida): topo de "Cliente respondeu".
 else if(row.sales_state?.urgent)group='customer_replied';
 else if(row.frozen_until && row.frozen_until>today || row.waiting_on==='scheduled_date' && !!row.next_action_due_date && row.next_action_due_date>today)group='scheduled';
 else if(row.sales_state?.readyForHuman)group='ready';
 else if(row.sales_state?.customerReplied)group='customer_replied';
 else if(row.waiting_on==='bank_or_admin')group='waiting';
 else if(tasks.length && tasks.every(t=>t.type==='customer_unresponsive') && !['conditions_approved_negotiation','financing_rejected'].includes(row.stage))group='no_response';
 else if(tasks.some(t=>(t.type==='scheduled_callback'||t.type==='customer_nudge'||t.type==='proposal_followup')&&t.due_date<=today) || !!row.next_action_due_date&&row.next_action_due_date<=today)group='due_today';
 else if(row.waiting_on==='customer')group='waiting';
 else if(tasks.some(t=>t.due_date<today))group='overdue';
 else if(tasks.some(t=>t.due_date<=today))group='action';
 else if(tasks.length)group='scheduled';
 else if(row.waiting_on==='team')group='action';
 const rank=['ready','customer_replied','due_today','overdue','action','scheduled','waiting','no_response','other'].indexOf(group);
 return {group,rank,label:SALES_QUEUE_LABELS[group]};
}
/** Quantos negócios caem em cada grupo da fila (mesma classificação do Kanban), para o contador "Para agir agora". */
export function countSalesQueueGroups(rows:SalesQueueInput[],now:string):Record<SalesQueueGroup,number>{
 const counts=Object.fromEntries(Object.keys(SALES_QUEUE_LABELS).map(k=>[k,0])) as Record<SalesQueueGroup,number>;
 for(const r of rows)counts[classifySalesQueue(r,now).group]++;
 return counts;
}
/** Grupos que pedem ação do vendedor agora, na ordem da fila. */
export const SALES_QUEUE_ACT_NOW_GROUPS:SalesQueueGroup[]=['ready','customer_replied','due_today','overdue'];
// How far along the sale is, across every operation's stage names. Unknown stages count as the lowest.
const STAGE_DEPTH:Record<string,number>={qualification:1,documentation:2,compatible_letter_search:2,proposal_sent:2,simulation_sent:2,plan_term_presented:2,awaiting_simulation:3,bank_analysis:3,negotiation:3,decision_negotiation:3,decision_objections:3,conditions_approved_negotiation:4,formalization:4,membership:4,analysis_transfer:4};
/** Interest first (hot handoff, then stage depth), so stale cold tasks never outrank a warm lead. */
const interest=(r:SalesQueueInput)=>(r.sales_state?.hot?10:0)+(STAGE_DEPTH[r.stage]??0);
/** Urgentes primeiro (o que espera há mais tempo antes); não urgentes depois, na ordem de sempre. */
const urgentOrder=(r:SalesQueueInput)=>{const u=r.sales_state?.urgent;if(!u||r.status!=='open')return Number.MAX_SAFE_INTEGER;const t=Date.parse(u.since);return Number.isFinite(t)?t:0;};
export function sortSalesQueue<T extends SalesQueueInput>(rows:T[],now:string):T[]{
 const effective=(r:T)=>(r.tasks??[]).flatMap(t=>t.consolidated_pendencies?.length?t.consolidated_pendencies:[t]);
 const urgency=(r:T)=>Math.max(0,...effective(r).map(t=>t.priority==='urgent'?2:t.priority==='high'?1:0));
 const due=(r:T)=>effective(r).map(t=>t.due_date).sort()[0]??r.next_action_due_date??'9999-12-31';
 return [...rows].sort((a,b)=>classifySalesQueue(a,now).rank-classifySalesQueue(b,now).rank||urgentOrder(a)-urgentOrder(b)||interest(b)-interest(a)||urgency(b)-urgency(a)||(b.last_interaction_at??'').localeCompare(a.last_interaction_at??'')||due(a).localeCompare(due(b))||b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id));
}

// ---- Urgente x follow-up (desenho 2026-11-22) ----
/** Cliente esperando a loja: alerta de prazo (sla), exceção do rodízio (ninguém respondeu) ou promessa de retorno vencida. */
export interface UrgentState { reason: 'sla' | 'exception' | 'promise'; since: string }
const URGENT_TEXT: Record<UrgentState['reason'], string> = { sla: 'cliente esperando', exception: 'ninguém respondeu', promise: 'retorno prometido vencido' };
function waited(sinceIso: string, now: string): string {
 const min = Math.max(0, Math.floor((Date.parse(now) - Date.parse(sinceIso)) / 60000));
 if (!Number.isFinite(min) || min < 60) return `${Number.isFinite(min) ? min : 0} min`;
 if (min < 1440) return `${Math.floor(min / 60)} h`;
 const d = Math.floor(min / 1440);
 return `${d} ${d === 1 ? 'dia' : 'dias'}`;
}
export function urgentBadge(u: UrgentState, now: string): string {
 return `Urgente · ${URGENT_TEXT[u.reason]} há ${waited(u.since, now)}`;
}
/** Loja esperando o cliente: lembrete de proposta ou "Cutucar cliente" vencido hoje. Destaque leve (sem piscar). */
export function followupBadge(tasks: SalesQueueInput['tasks'], now: string): { kind: 'proposal' | 'nudge'; label: string } | null {
 const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
 const flat = (tasks ?? []).flatMap(t => t.consolidated_pendencies?.length ? t.consolidated_pendencies : [t]).filter(t => t.due_date <= today);
 if (flat.some(t => t.type === 'proposal_followup')) return { kind: 'proposal', label: 'Follow-up · proposta sem resposta' };
 if (flat.some(t => t.type === 'customer_nudge')) return { kind: 'nudge', label: 'Follow-up · cliente sem responder' };
 return null;
}
