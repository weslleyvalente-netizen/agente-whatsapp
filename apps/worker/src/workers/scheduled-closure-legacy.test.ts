import {it,vi,expect,beforeEach} from 'vitest';
const m=vi.hoisted(()=>({handler:null as any,getRecentMessages:vi.fn(),getAllOrganizations:vi.fn(),getAgentsByOrganization:vi.fn(),getStaleWaitingConversations:vi.fn().mockResolvedValue([{id:'c',contact_id:'p'}]),getStalePricedConversations:vi.fn().mockResolvedValue([]),scheduled:vi.fn().mockResolvedValue(new Set(['c']))}));
vi.mock('bullmq',()=>({Worker:class{constructor(_name:any,handler:any){m.handler=handler;}on(){}}}));
vi.mock('@aula-agente/database',()=>({...m,getAdminClient:()=>({}),hasFrozenContact:vi.fn().mockResolvedValue(false),OPEN_TASK_STATUSES:['pending']}));
vi.mock('@aula-agente/queue',()=>({getRedisConnection:()=>({}),getStaleConversationFollowupQueue:()=>({upsertJobScheduler:vi.fn()}),getSendMessageQueue:()=>({})}));
vi.mock('./scheduled-ad-closure.js',()=>({runScheduledAdClosureCheck:m.scheduled}));
vi.mock('./low-intent-followup.js',()=>({runLowIntentCadenceCheck:vi.fn(async()=>new Set())}));
vi.mock('./libera-cred-resumption.js',()=>({runLiberaCredResumptionCheck:vi.fn().mockResolvedValue({created:0,escalated:0,suggestedLost:0})}));
import {startStaleConversationFollowupWorker} from './stale-conversation-followup.js';
beforeEach(()=>{vi.clearAllMocks();m.getAllOrganizations.mockResolvedValue([{id:'org',settings:{},stale_conversation_hours:1}]);});
it.each([true,false])('a fila agendada suprime tarefas e mensagens do fluxo antigo (ativo=%s)',async(ativo)=>{
 m.getAgentsByOrganization.mockResolvedValue([{id:'a',is_active:true,tools_config:{followup_automatico:{ativo,primeiro_followup_horas:1,segundo_followup_horas:23}}}]);
 startStaleConversationFollowupWorker();await m.handler();expect(m.scheduled).toHaveBeenCalled();expect(m.getRecentMessages).not.toHaveBeenCalled();
});
