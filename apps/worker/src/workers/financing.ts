import { Queue, Worker } from 'bullmq';
import { getRedisConnection } from '@aula-agente/queue';
import {
  getAdminClient, CredProMockAdapter, openFinancingApplication, lastBusinessDay, requeryDate, saoPauloDate,
  type SupabaseClient, type FinancingAdapter, type BusinessCalendar,
} from '@aula-agente/database';

/** Durable SQL leases keep multiple worker instances from duplicating work.
 * Queue payload contains no customer data; no client notification is enqueued.
 */
export async function runFinancingSweep(db: SupabaseClient, adapter: FinancingAdapter, calendar: BusinessCalendar | null) {
  if (adapter.mode !== 'mock') throw new Error('Only local mock is enabled');
  const today = saoPauloDate();
  const [year,month] = today.split('-').map(Number);
  if (calendar && calendar.years.includes(year) && lastBusinessDay(year,month-1,calendar)===today) {
    const scheduled = await db.rpc('financing_schedule_requeries');
    if (scheduled.error) throw new Error('Financing scheduling failed');
  }
  let completed=0;
  for(let i=0;i<20;i++) {
    const claim=await db.rpc('financing_claim');
    if(claim.error)throw new Error('Financing claim failed');
    const request=claim.data?.[0]; if(!request)break;
    const application=openFinancingApplication(request.application_encrypted);
    // The local mock is deterministic and safe to repeat after a crash. A real
    // adapter must implement provider idempotency/reconciliation before enabling.
    const results=await Promise.all((request.banks as string[]).map(async bank=>{
      try { return {bank,...await adapter.submit(bank,application,`${request.id}-${bank}`)}; }
      catch { return {bank,status:'error',offers:[]}; }
    }));
    let due: string|null=null;
    if(calendar && request.attempt===0 && results.every(r=>r.status==='rejected')) {
      try { due=requeryDate(saoPauloDate(new Date(request.first_started_at)),calendar); }
      catch { /* Missing calendar coverage blocks automatic requery. */ }
    }
    const result=await db.rpc('financing_complete',{
      p_id:request.id,p_token:request.lease_token,p_results:results,p_requery:due,
    });
    if(result.error)throw new Error('Financing completion failed');
    if(result.data)completed++;
  }
  return {completed};
}
export function financingCalendar(): BusinessCalendar|null {
  try {
    const data=JSON.parse(process.env.FINANCING_BUSINESS_CALENDAR || 'null');
    if(!data || !Array.isArray(data.years) || !data.years.length || !data.years.every((y:unknown)=>Number.isInteger(y)) ||
      !Array.isArray(data.holidays) || !data.holidays.every((d:unknown)=>typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))return null;
    return data;
  } catch {return null;}
}
export async function startFinancingWorker() {
  const connection=getRedisConnection();
  const queue=new Queue('financing-mock-sweep',{connection});
  const worker=new Worker('financing-mock-sweep',async()=>runFinancingSweep(getAdminClient(),new CredProMockAdapter(),financingCalendar()),{connection,concurrency:1});
  worker.on('failed',()=>console.error('Financing mock sweep failed')); // no payload/PII
  await queue.upsertJobScheduler('financing-mock-scheduler',{every:60_000},{name:'sweep',opts:{removeOnComplete:20,removeOnFail:20}});
  return {async close(){await worker.close();await queue.close();}};
}
