import {it,expect,vi} from 'vitest';
import {getQualificationByConversationId} from './conversation-qualification.js';
import {syncSalesPipeline} from './sales-pipeline.js';
vi.mock('./organizations.js',()=>({getOrganizationById:vi.fn().mockResolvedValue({settings:{sales_auto_pipeline_enabled:true,sales_qualified_handoff_task_enabled:true}})}));
vi.mock('./conversation-qualification.js',()=>({getQualificationByConversationId:vi.fn().mockResolvedValue({attendance_type:'financing',product_model:'CG160 Titan',cpf_encrypted:'encrypted',birth_date:'1990-01-01',has_driver_license:true,down_payment_amount:3000})}));
vi.mock('./messages.js',()=>({getMessageById:vi.fn()}));
it('checks the real pending handoff before routing a qualified acknowledgment',async()=>{
 const rpc=vi.fn().mockResolvedValue({data:'opp',error:null});
 const db={rpc,from:(table:string)=>{
  const q:any={select:()=>q,eq:()=>q,is:()=>q,order:()=>q,limit:()=>q,single:()=>Promise.resolve({data:{contact_id:'contact'},error:null}),maybeSingle:()=>Promise.resolve({data:table==='handoff_events'?{id:'handoff'}:{id:'message',organization_id:'org',content:'Ok'},error:null}),then:(resolve:any)=>resolve({data:table==='messages'?[{id:'message',organization_id:'org',content:'Ok'}]:[],error:null})};return q;
 }};
 await syncSalesPipeline(db as any,'org','conversation');
 expect(rpc).toHaveBeenCalledWith('sync_sales_pipeline',expect.objectContaining({p_stage:'awaiting_simulation'}));
});

it('uses contact history to create a missing card',async()=>{
 vi.mocked(getQualificationByConversationId).mockResolvedValueOnce(null);
 const rpc=vi.fn().mockResolvedValue({data:'opp',error:null});
 const history=[{id:'latest',organization_id:'org',content:'Valor'},{id:'interest',organization_id:'org',content:'Ta quanto a moto elétrica'}];
 const db={rpc,from:(table:string)=>{
  const q:any={select:()=>q,eq:()=>q,is:()=>q,order:()=>q,limit:()=>q,single:()=>Promise.resolve({data:{contact_id:'contact'},error:null}),maybeSingle:()=>Promise.resolve({data:null,error:null}),then:(resolve:any)=>resolve({data:table==='messages'?history:[],error:null})};return q;
 }};
 await syncSalesPipeline(db as any,'org','conversation');
 expect(rpc).toHaveBeenCalledWith('sync_sales_pipeline',expect.objectContaining({p_operation:'vehicle_sale',p_stage:'interest_received',p_customer_message_id:'latest'}));
});


it('passes the pending request_human motive to the policy',async()=>{
 vi.mocked(getQualificationByConversationId).mockResolvedValueOnce(null);
 const rpc=vi.fn().mockResolvedValue({data:'opp',error:null});
 const filters:unknown[][]=[];
 const db={rpc,from:(table:string)=>{
  const q:any={select:(fields:string)=>{if(table==='handoff_events')filters.push(['select',fields]);return q},eq:(...args:unknown[])=>{if(table==='handoff_events')filters.push(['eq',...args]);return q},is:(...args:unknown[])=>{if(table==='handoff_events')filters.push(['is',...args]);return q},order:()=>q,limit:()=>q,single:()=>Promise.resolve({data:{contact_id:'contact'},error:null}),maybeSingle:()=>Promise.resolve({data:{id:'handoff',motivo:'negociacao_valor'},error:null}),then:(resolve:any)=>resolve({data:table==='messages'?[{id:'message',organization_id:'org',content:'Ok'}]:[{operation:'consortium'}],error:null})};return q;
 }};
 await syncSalesPipeline(db as any,'org','conversation');
 expect(rpc).toHaveBeenCalledWith('sync_sales_pipeline',expect.objectContaining({p_operation:'consortium',p_stage:'decision_negotiation'}));
 expect(filters).toEqual(expect.arrayContaining([['select','id,motivo'],['eq','organization_id','org'],['eq','conversation_id','conversation'],['eq','trigger_type','request_human'],['is','first_human_reply_at',null]]));
});

it('creates Alessandro missing card from chronological contact history',async()=>{
 vi.mocked(getQualificationByConversationId).mockResolvedValueOnce(null);
 const rpc=vi.fn().mockResolvedValue({data:'opp',error:null});
 const history=['🤷‍♂️','Moto','Tenho interesse em consórciobaadae'].map((content,i)=>({id:String(i),organization_id:'org',content}));
 const db={rpc,from:(table:string)=>{
  const q:any={select:()=>q,eq:()=>q,is:()=>q,order:()=>q,limit:()=>q,single:()=>Promise.resolve({data:{contact_id:'contact'},error:null}),maybeSingle:()=>Promise.resolve({data:null,error:null}),then:(resolve:any)=>resolve({data:table==='messages'?history:[],error:null})};return q;
 }};
 await syncSalesPipeline(db as any,'org','conversation');
 expect(rpc).toHaveBeenCalledWith('sync_sales_pipeline',expect.objectContaining({p_operation:'consortium',p_stage:'interest_received',p_customer_message_id:'0'}));
});


it('card do encaminhamento com operação padrão (27/10): a decisão usa a conversa, não o padrão vehicle_sale',async()=>{
 const qual={attendance_type:'consortium',product_model:'moto',cpf_encrypted:null};
 const run=async(opps:any[])=>{
  vi.mocked(getQualificationByConversationId).mockResolvedValueOnce(qual as any);
  const rpc=vi.fn().mockResolvedValue({data:'opp',error:null});
  const history=[{id:'m2',organization_id:'org',content:'quero uma carta de crédito'},{id:'m1',organization_id:'org',content:'quero consorcio'}];
  const db={rpc,from:(table:string)=>{
   const q:any={select:()=>q,eq:()=>q,is:()=>q,order:()=>q,limit:()=>q,single:()=>Promise.resolve({data:{contact_id:'contact'},error:null}),maybeSingle:()=>Promise.resolve({data:table==='handoff_events'?{id:'h',motivo:'cliente_pediu'}:null,error:null}),then:(resolve:any)=>resolve({data:table==='messages'?history:table==='opportunities'?opps:[],error:null})};return q;
  }};
  await syncSalesPipeline(db as any,'org','conversation');
  return rpc.mock.calls[0]?.[1];
 };
 const withoutCard=await run([]);
 const withDefaultCard=await run([{operation:'vehicle_sale',operation_is_default:true}]);
 expect(withoutCard).toMatchObject({p_operation:'consortium',p_stage:'decision_negotiation'});
 const {p_default_correction,...rest}=withDefaultCard;
 expect(p_default_correction).toBe(true); // único acréscimo: o sinal novo
 expect(rest).toEqual(withoutCard); // idêntico ao comportamento de antes do card
 // card com operação confirmada continua usando a operação dele como prior
 const confirmed=await run([{operation:'vehicle_sale',operation_is_default:false}]);
 expect(confirmed).toMatchObject({p_operation:'vehicle_sale'});
});

it('card padrão: manda p_default_correction=true; sem a migração (função não encontrada) repete sem o parâmetro; sem card nunca manda',async()=>{
 const mk=(opps:any[],rpc:any)=>({rpc,from:(table:string)=>{
  const q:any={select:()=>q,eq:()=>q,is:()=>q,order:()=>q,limit:()=>q,single:()=>Promise.resolve({data:{contact_id:'contact'},error:null}),maybeSingle:()=>Promise.resolve({data:null,error:null}),then:(resolve:any)=>resolve({data:table==='messages'?[{id:'m',organization_id:'org',content:'quero consorcio'}]:table==='opportunities'?opps:[],error:null})};return q;
 }});
 const ok=vi.fn().mockResolvedValue({data:'opp',error:null});
 await syncSalesPipeline(mk([{operation:'vehicle_sale',operation_is_default:true}],ok) as any,'org','conversation');
 expect(ok).toHaveBeenCalledWith('sync_sales_pipeline',expect.objectContaining({p_default_correction:true}));
 const old=vi.fn().mockResolvedValueOnce({data:null,error:{code:'PGRST202'}}).mockResolvedValueOnce({data:'opp',error:null});
 expect(await syncSalesPipeline(mk([{operation:'vehicle_sale',operation_is_default:true}],old) as any,'org','conversation')).toBe('opp');
 expect(old.mock.calls[1][1]).not.toHaveProperty('p_default_correction');
 const none=vi.fn().mockResolvedValue({data:'opp',error:null});
 await syncSalesPipeline(mk([],none) as any,'org','conversation');
 expect(none.mock.calls[0][1]).not.toHaveProperty('p_default_correction');
});
