import {it,expect,vi,afterEach} from 'vitest';
const m=vi.hoisted(()=>({handle:vi.fn(),getInstance:vi.fn().mockResolvedValue({instance_name:'loja'}),message:{id:'m',role:'agent',content:'Despedida',metadata:{scheduled_ad_closure:{batch_id:'batch'}}}}));
vi.mock('@aula-agente/database',()=>({getAdminClient:()=>({}),getMessageById:vi.fn(async()=>m.message),getInstanceById:m.getInstance}));
vi.mock('./scheduled-ad-closure.js',()=>({processScheduledAdClosure:m.handle,shouldSuppressScheduledAdLegacySend:vi.fn()}));
import {processSendMessageJob} from './send-message.js';
const data={conversationId:'c',messageId:'m',instanceId:'i',phone:'5511',content:'Despedida',organizationId:'org'};
const fetchBefore=global.fetch;
afterEach(()=>{global.fetch=fetchBefore;vi.clearAllMocks();});
it('o worker usa o fluxo protegido e passa o timeout à Evolution',async()=>{
 process.env.EVOLUTION_API_URL='https://evolution.test';process.env.EVOLUTION_API_KEY='test';
 const signal=AbortSignal.timeout(30000);
 m.handle.mockImplementationOnce(async(_db,_data,_message,send)=>send('Texto aprovado',signal));
 global.fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({key:{id:'EVO'}})}) as any;
 await processSendMessageJob({data});
 expect(m.handle).toHaveBeenCalledWith(expect.anything(),data,m.message,expect.any(Function));
 expect(global.fetch).toHaveBeenCalledWith('https://evolution.test/message/sendText/loja',expect.objectContaining({signal,body:JSON.stringify({number:'5511',text:'Texto aprovado'})}));
});
it('não cai no envio genérico quando a fila está pausada/cancelada',async()=>{
 m.handle.mockResolvedValueOnce(undefined);global.fetch=vi.fn();
 await processSendMessageJob({data});expect(global.fetch).not.toHaveBeenCalled();expect(m.getInstance).not.toHaveBeenCalled();
});
