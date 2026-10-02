import {it,expect} from 'vitest';
import {claimAdClosureSend,completeAdClosureTasks} from './ad-closure.js';
function fake(rows:Record<string,any[]>) {
 let failEvent=false;
 function client(){return {from:(table:string)=>{
  let filters:Array<(r:any)=>boolean>=[],payload:any,inserted=false;
  const value=(row:any,key:string)=>key.split(/->>?/).reduce((v:any,k:string)=>v?.[k],row);
  const run=()=>{
   if(inserted){if(failEvent){failEvent=false;return {data:null,error:new Error('event failed')};}const row={...payload,id:'event-'+rows[table].length,created_at:new Date().toISOString()};rows[table].push(row);return {data:row,error:null};}
   const matches=rows[table].filter(r=>filters.every(f=>f(r)));if(payload)for(const r of matches)Object.assign(r,payload);return {data:matches,error:null};
  };
  const q:any={select:()=>q,order:()=>q,eq:(k:string,v:any)=>(filters.push(r=>value(r,k)===v),q),is:(k:string,v:any)=>(filters.push(r=>v===null?value(r,k)==null:value(r,k)===v),q),in:(k:string,v:any[])=>(filters.push(r=>v.includes(value(r,k))),q),update:(p:any)=>(payload=p,q),insert:(p:any)=>(payload=p,inserted=true,q),maybeSingle:async()=>{const result=run();return {...result,data:Array.isArray(result.data)?result.data[0]??null:result.data};},single:async()=>{const result=run();const data=Array.isArray(result.data)?result.data[0]:result.data;return {data,error:result.error??(!data?new Error('missing'):null)};},then:(resolve:any,reject:any)=>Promise.resolve(run()).then(resolve,reject)};return q;
 }};}
 return {db:client() as any,failNextEvent:()=>{failEvent=true;}};
}
const initial={id:'m',organization_id:'org',conversation_id:'c',evolution_message_id:null,content:'Despedida',metadata:{scheduled_ad_closure:{batch_id:'b'}}};
const task={id:'t',organization_id:'org',contact_id:'p',type:'customer_unresponsive',status:'pending',updated_at:'stamp',created_by_type:'ai',completed_at:null,consolidated_pendencies:[]};
const r={contactId:'p',conversationId:'c',initialMessageId:'first',scheduledAt:'2026-10-03T11:00Z',group:'a',tasks:[{id:'t',updated_at:'stamp'}]};
it('a reserva persistente só permite uma tentativa mesmo sem Redis',async()=>{const rows={messages:[structuredClone(initial)]};const {db}=fake(rows);expect(await claimAdClosureSend(db,initial as any,'now')).toBe(true);expect(await claimAdClosureSend(db,initial as any,'later')).toBe(false);expect(rows.messages[0].metadata.scheduled_ad_closure).toMatchObject({attempted_at:'now'});});
it('só conclui depois da confirmação, com texto no evento e sem apagar registro',async()=>{const rows:any={messages:[structuredClone(initial)],tasks:[structuredClone(task)],task_events:[]};const {db}=fake(rows);await completeAdClosureTasks(db,'org',r,initial as any);expect(rows.tasks[0].status).toBe('pending');rows.messages[0].evolution_message_id='EVO';rows.messages[0].metadata.scheduled_ad_closure.attempted_at='2026-10-03T11:00:00Z';await completeAdClosureTasks(db,'org',r,initial as any);expect(rows.tasks).toHaveLength(1);expect(rows.tasks[0].status).toBe('completed');expect(JSON.parse(rows.task_events[0].note)).toMatchObject({text:'Despedida',message_id:'m',evolution_message_id:'EVO'});});
it('não conclui tarefa editada e não altera outra organização',async()=>{const confirmed:any={...initial,evolution_message_id:'EVO',metadata:{scheduled_ad_closure:{batch_id:'b',attempted_at:'now'}}};const rows:any={messages:[confirmed],tasks:[{...task,updated_at:'edited'}],task_events:[]};const {db}=fake(rows);await completeAdClosureTasks(db,'other',r,confirmed);await completeAdClosureTasks(db,'org',r,confirmed);expect(rows.tasks[0].status).toBe('pending');expect(rows.task_events).toHaveLength(0);});
it('recupera evento após falha sem repetir conclusão nem mensagem',async()=>{const confirmed:any={...initial,evolution_message_id:'EVO',metadata:{scheduled_ad_closure:{batch_id:'b',attempted_at:'now'}}};const rows:any={messages:[confirmed],tasks:[structuredClone(task)],task_events:[]};const {db,failNextEvent}=fake(rows);failNextEvent();await expect(completeAdClosureTasks(db,'org',r,confirmed)).rejects.toThrow('event failed');expect(rows.tasks[0].status).toBe('completed');await completeAdClosureTasks(db,'org',r,confirmed);await completeAdClosureTasks(db,'org',r,confirmed);expect(rows.task_events).toHaveLength(1);});
