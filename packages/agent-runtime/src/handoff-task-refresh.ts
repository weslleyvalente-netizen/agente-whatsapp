import {buildConsolidatedDescription,earliestDueDate,pickPrimaryPendency,toISODateInTimeZone,type Task,type TaskEvent} from "@aula-agente/shared";

/** Refresh only expired AI return reminders. Customer promises and unrelated pendencies remain intact. */
export function buildHandoffTaskRefresh(task:Task,resumo:string,now:Date,start:number,end:number,events:ReadonlyArray<Pick<TaskEvent,"event_type"|"created_by_type">>=[]):Partial<Task>|null {
 // Even AI-created reminders may have a manually chosen schedule. Preserve
 // the whole task, including consolidated pendencies, after human edits.
 if(events.some(event=>event.created_by_type==="human" && ["updated","rescheduled"].includes(event.event_type)))return null;
 if(!["pending","in_progress"].includes(task.status)||task.created_by_type!=="ai"||task.followup_pending_message_id||!resumo.trim())return null;
 const today=toISODateInTimeZone(now);
 const hour=Number(new Intl.DateTimeFormat("en-US",{timeZone:"America/Sao_Paulo",hour:"2-digit",hourCycle:"h23"}).format(now));
 const due_date=hour>=end?toISODateInTimeZone(new Date(now.getTime()+86400000)):today;
 const due_time=`${String(hour<start||hour>=end?start:hour).padStart(2,"0")}:00:00`;
 const priority=task.priority==="urgent"?"urgent":"high";
 const pendencies=task.consolidated_pendencies??[];
 if(pendencies.length){
  let changed=false;
  const refreshed=pendencies.map(p=>{
   if(p.type!=="return_customer"||p.added_by_type!=="ai"||p.due_date>=today||p.freeze_opportunity_id)return p;
   changed=true;return {...p,description:resumo,priority:p.priority==="urgent"?"urgent" as const:"high" as const,due_date,due_time,added_at:now.toISOString()};
  });
  if(!changed)return null;
  const primary=pickPrimaryPendency(refreshed)!;
  return {consolidated_pendencies:refreshed,description:buildConsolidatedDescription(refreshed),ai_summary:resumo,type:primary.type,priority:primary.priority,due_date:earliestDueDate(refreshed)!,due_time:primary.due_time};
 }
 if(task.type!=="return_customer"||task.due_date>=today)return null;
 return {description:resumo,ai_summary:resumo,priority,due_date,due_time};
}
