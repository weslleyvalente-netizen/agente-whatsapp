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
