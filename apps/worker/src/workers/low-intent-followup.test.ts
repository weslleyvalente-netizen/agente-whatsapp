import {beforeEach,describe,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({hasFrozenContact:vi.fn().mockResolvedValue(false),getStaleWaitingConversations:vi.fn(),getConversationById:vi.fn(),getLastContactMessage:vi.fn(),getRecentMessages:vi.fn(),getOpenTaskByConversation:vi.fn(),getOpenHandoffEvent:vi.fn(),createMessage:vi.fn(),updateConversation:vi.fn(),add:vi.fn(),acquire:vi.fn(),release:vi.fn(),eval:vi.fn()}));
vi.mock("@aula-agente/database",()=>m);
vi.mock("@aula-agente/queue",()=>({getSendMessageQueue:()=>({add:m.add}),getRedisConnection:()=>({eval:m.eval})}));
vi.mock("../lib/lock.js",()=>({acquireConversationLock:m.acquire,releaseConversationLock:m.release}));
import {runLowIntentFollowup,runLowIntentCadenceCheck} from "./low-intent-followup.js";
const anchor="2026-10-01T10:00:00.000Z";
function db(messages:any[]=[],opportunities:any[]=[]) {return {from:(table:string)=>{const q:any={select:()=>q,eq:()=>q,gte:()=>q,order:()=>q,range:async()=>({data:table==="messages"?messages:opportunities,error:null})};return q;}};}
const org={id:"org",settings:{sales_low_intent_cadence_enabled:true,sales_low_intent_cadence_started_at:anchor}};
beforeEach(()=>{vi.clearAllMocks();m.acquire.mockResolvedValue("lock");m.eval.mockResolvedValue(1);m.getStaleWaitingConversations.mockResolvedValue([]);m.getLastContactMessage.mockResolvedValue({created_at:anchor});m.getConversationById.mockResolvedValue({id:"c",contact_id:"p",is_human_takeover:false,evolution_instance_id:"i",wa_contacts:{phone:"5511",ai_disabled:false}});m.getRecentMessages.mockResolvedValue([{role:"agent"}]);m.getOpenTaskByConversation.mockResolvedValue(null);m.getOpenHandoffEvent.mockResolvedValue(null);m.createMessage.mockResolvedValue({id:"msg"});});
describe("low intent followup",()=>{
 it("does nothing with flag off",async()=>{expect(await runLowIntentFollowup(db() as any,{...org,settings:{}} as any,"c",anchor,new Date("2026-10-01T11:00Z"))).toBe(false);expect(m.acquire).not.toHaveBeenCalled();});
 it("queues one first touch without any task and without automatic retries",async()=>{
  const handled=await runLowIntentFollowup(db([{role:"agent",created_at:anchor,metadata:null}]) as any,org as any,"c",anchor,new Date("2026-10-01T11:00Z"));
  expect(handled).toBe(true);expect(m.add).toHaveBeenCalledWith("send-message",expect.objectContaining({messageId:"msg"}),{attempts:1,jobId:"low-intent-msg"});expect(m.createMessage).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({metadata:{low_intent_followup:{anchor,stage:1}}}));
 });
 it("blocks a send when the instance quota or interval is exhausted",async()=>{m.eval.mockResolvedValue(0);await runLowIntentFollowup(db([{role:"agent",created_at:anchor,metadata:null}]) as any,org as any,"c",anchor,new Date("2026-10-01T11:00Z"));expect(m.add).not.toHaveBeenCalled();expect(m.createMessage).not.toHaveBeenCalled();});
 it("sends a final availability message at 48h",async()=>{
  const messages=[{role:"agent",created_at:anchor,metadata:null},...([1,2] as const).map(stage=>({role:"agent",evolution_message_id:"sent",metadata:{low_intent_followup:{anchor,stage}}}))];
  await runLowIntentFollowup(db(messages) as any,org as any,"c",anchor,new Date("2026-10-03T11:00Z"));
  expect(m.createMessage).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({content:expect.stringContaining("estamos à disposição"),metadata:{low_intent_followup:{anchor,stage:3}}}));
 });
 it("does not advance after an unconfirmed delivery",async()=>{
  await runLowIntentFollowup(db([{role:"agent",created_at:anchor,metadata:null},{role:"agent",evolution_message_id:null,metadata:{low_intent_followup:{anchor,stage:1}}}]) as any,org as any,"c",anchor,new Date("2026-10-02T09:00Z"));expect(m.add).not.toHaveBeenCalled();
 });
 it("keeps human handoffs and advanced deals in their existing flow",async()=>{
  m.getOpenHandoffEvent.mockResolvedValue({id:"handoff"});expect(await runLowIntentFollowup(db() as any,org as any,"c",anchor,new Date())).toBe(false);expect(m.add).not.toHaveBeenCalled();
  m.getOpenHandoffEvent.mockResolvedValue(null);expect(await runLowIntentFollowup(db([],[{status:"open",stage:"membership",waiting_on:null}]) as any,org as any,"c",anchor,new Date())).toBe(false);
 });
 it("rechecks customer response inside the lock",async()=>{m.getRecentMessages.mockResolvedValue([{role:"contact"}]);expect(await runLowIntentFollowup(db() as any,org as any,"c",anchor,new Date())).toBe(true);expect(m.add).not.toHaveBeenCalled();expect(m.release).toHaveBeenCalled();});
});

it("suppresses both cadences for a closed business",async()=>{
 const handled=await runLowIntentFollowup(db([{role:"agent",created_at:anchor,metadata:null}],[{status:"lost",stage:"qualification"}]) as any,org as any,"c",anchor,new Date("2026-10-01T11:00Z"));expect(handled).toBe(true);expect(m.add).not.toHaveBeenCalled();
});
it("scans the new cadence independently with a one-hour cutoff",async()=>{
 m.getStaleWaitingConversations.mockResolvedValue([{id:"c",created_at:anchor}]);
 const handled=await runLowIntentCadenceCheck(db([{role:"agent",created_at:anchor,metadata:null}]) as any,org as any,"agent",new Date("2026-10-01T11:00Z"));
 expect(m.getStaleWaitingConversations).toHaveBeenCalledWith(expect.anything(),"org","agent","2026-10-01T10:00:00.000Z");expect(handled.has("c")).toBe(true);
});

it("excludes a closed deal even if an old unresponsive task remains open",async()=>{
 m.getOpenTaskByConversation.mockResolvedValue({id:"old-task",type:"customer_unresponsive"});
 expect(await runLowIntentFollowup(db([],[{status:"lost",stage:"qualification"}]) as any,org as any,"c",anchor,new Date("2026-10-01T11:00Z"))).toBe(true);expect(m.add).not.toHaveBeenCalled();
});

it("não retoma cadência automática em negócio com retorno combinado",async()=>{m.hasFrozenContact.mockResolvedValueOnce(true);expect(await runLowIntentFollowup(db() as any,org as any,"c",anchor,new Date())).toBe(true);expect(m.add).not.toHaveBeenCalled();});
