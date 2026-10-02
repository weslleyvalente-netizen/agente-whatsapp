export interface SalesQueueInput {id:string;created_at:string;status:string;stage:string;waiting_on:string|null;next_action_due_date:string|null;frozen_until?:string|null;sales_state?:{readyForHuman:boolean;customerReplied:boolean;humanPending:boolean;taskCount:number};tasks?:Array<{type:string;due_date:string;priority:string;consolidated_pendencies?:Array<{type:string;due_date:string;priority:string}>}>;}
export const SALES_QUEUE_LABELS = {ready:'Pronto para Marina',customer_replied:'Cliente respondeu',due_today:'Compromissos de hoje',overdue:'Pendências com interesse',action:'Próximas ações',scheduled:'Retornos futuros',waiting:'Aguardando cliente ou banco',no_response:'Sem resposta',other:'Outros'} as const;
export type SalesQueueGroup=keyof typeof SALES_QUEUE_LABELS;
export function classifySalesQueue(row:SalesQueueInput,now:string){
 const today=new Date(now).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
 const tasks=(row.tasks??[]).flatMap(t=>t.consolidated_pendencies?.length?t.consolidated_pendencies:[t]);
 let group:SalesQueueGroup='other';
 if(row.status!=='open')group='other';
 else if(row.frozen_until && row.frozen_until>today || row.waiting_on==='scheduled_date' && !!row.next_action_due_date && row.next_action_due_date>today)group='scheduled';
 else if(row.sales_state?.readyForHuman)group='ready';
 else if(row.sales_state?.customerReplied)group='customer_replied';
 else if(row.waiting_on==='bank_or_admin')group='waiting';
 else if(tasks.length && tasks.every(t=>t.type==='customer_unresponsive') && !['conditions_approved_negotiation','financing_rejected'].includes(row.stage))group='no_response';
 else if(tasks.some(t=>t.type==='scheduled_callback'&&t.due_date<=today) || !!row.next_action_due_date&&row.next_action_due_date<=today)group='due_today';
 else if(row.waiting_on==='customer')group='waiting';
 else if(tasks.some(t=>t.due_date<today))group='overdue';
 else if(tasks.some(t=>t.due_date<=today))group='action';
 else if(tasks.length)group='scheduled';
 else if(row.waiting_on==='team')group='action';
 const rank=['ready','customer_replied','due_today','overdue','action','scheduled','waiting','no_response','other'].indexOf(group);
 return {group,rank,label:SALES_QUEUE_LABELS[group]};
}
export function sortSalesQueue<T extends SalesQueueInput>(rows:T[],now:string):T[]{
 const effective=(r:T)=>(r.tasks??[]).flatMap(t=>t.consolidated_pendencies?.length?t.consolidated_pendencies:[t]);
 const urgency=(r:T)=>Math.max(0,...effective(r).map(t=>t.priority==='urgent'?2:t.priority==='high'?1:0));
 const due=(r:T)=>effective(r).map(t=>t.due_date).sort()[0]??r.next_action_due_date??'9999-12-31';
 return [...rows].sort((a,b)=>classifySalesQueue(a,now).rank-classifySalesQueue(b,now).rank||urgency(b)-urgency(a)||due(a).localeCompare(due(b))||b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id));
}
