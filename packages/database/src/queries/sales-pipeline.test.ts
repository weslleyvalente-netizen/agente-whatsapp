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
