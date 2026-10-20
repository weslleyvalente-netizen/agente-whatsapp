import { describe,it,expect,vi } from 'vitest';
import { runFinancingSweep } from './financing.js';
import { sealFinancingApplication, type SupabaseClient, type FinancingAdapter } from '@aula-agente/database';
function fixture(){
  process.env.QUALIFICATION_CPF_ENCRYPTION_KEY='a'.repeat(64);process.env.QUALIFICATION_CPF_HASH_PEPPER='test';
  const application={vehicle:{id:1},customer:{cpf:'synthetic-fixture'}};
  let claimed=false;const completed:any[]=[];const calls:string[]=[];
  const db={rpc:async(name:string,p?:any)=>{
    calls.push(name);
    if(name==='financing_claim'){
      if(claimed)return {data:[],error:null};claimed=true;
      return {data:[{id:'req',lease_token:'lease',application_encrypted:sealFinancingApplication(application,'consent').encrypted,banks:['one','two'],attempt:0,first_started_at:'2026-10-20T12:00:00Z'}],error:null};
    }
    if(name==='financing_complete')completed.push(p);
    return {data:true,error:null};
  }} as unknown as SupabaseClient;
  return {db,completed,calls,application};
}
describe('financing worker',()=>{
  it('passes the same derived application to parallel adapters and persists both results',async()=>{
    const f=fixture();let started=0;let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
    const adapter:FinancingAdapter={mode:'mock',submit:async(_bank,app)=>{
      expect(app).toEqual(f.application);started++;if(started===2)release();await gate;return {status:'rejected',offers:[]};
    }};
    await runFinancingSweep(f.db,adapter,{years:[2026],holidays:[]});
    expect(f.completed[0].p_results).toEqual([{bank:'one',status:'rejected',offers:[]},{bank:'two',status:'rejected',offers:[]}]);
    expect(f.completed[0].p_requery).toBe('2026-10-30');
  });
  it('preserves the other bank result when one adapter fails',async()=>{
    const f=fixture();const adapter:FinancingAdapter={mode:'mock',submit:async bank=>{if(bank==='one')throw Error('sensitive provider payload');return {status:'simulation',offers:[]};}};
    await runFinancingSweep(f.db,adapter,null);
    expect(f.completed[0].p_results).toEqual([{bank:'one',status:'error',offers:[]},{bank:'two',status:'simulation',offers:[]}]);
    expect(f.completed[0].p_requery).toBeNull();
  });
  it('does not schedule automatic reconsultations without a business calendar',async()=>{
    const f=fixture();const adapter:FinancingAdapter={mode:'mock',submit:async()=>({status:'rejected',offers:[]})};
    await runFinancingSweep(f.db,adapter,null);
    expect(f.calls).not.toContain('financing_schedule_requeries');expect(f.completed[0].p_requery).toBeNull();
  });
});
