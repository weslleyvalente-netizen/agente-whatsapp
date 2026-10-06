import {beforeEach,describe,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({getSilenceRetirementCandidates:vi.fn(),retireSilenceTask:vi.fn(),set:vi.fn()}));
vi.mock("@aula-agente/database",()=>m);
vi.mock("@aula-agente/queue",()=>({getRedisConnection:()=>({set:m.set})}));
import {runSilenceRetirementCheck} from "./silence-retirement.js";
const now=new Date("2026-10-10T12:00:00Z");
const candidate=(over:any={})=>({rawTask:{id:"t1"},task:{status:"pending",type:"customer_unresponsive",created_by_type:"ai",consolidated_pendencies:[]},otherOpenTasks:0,lastCustomerMessageAt:"2026-10-01T12:00:00Z",reachedOutAfterCustomer:true,humanTouchAfterCustomer:false,hasPendingHandoff:false,isHumanTakeover:false,openOpportunities:[],...over});
const org={id:"org",settings:{silence_task_auto_retire_enabled:true}};
beforeEach(()=>{vi.clearAllMocks();m.set.mockResolvedValue("OK");m.retireSilenceTask.mockResolvedValue(true);});
describe("silence retirement worker",()=>{
 it("does nothing with the flag off and never reads candidates",async()=>{
  expect(await runSilenceRetirementCheck({} as any,{id:"org",settings:{}} as any,now)).toBe(0);
  expect(m.getSilenceRetirementCandidates).not.toHaveBeenCalled();
 });
 it("runs at most once per day per organization",async()=>{
  m.set.mockResolvedValue(null);
  expect(await runSilenceRetirementCheck({} as any,org as any,now)).toBe(0);
  expect(m.getSilenceRetirementCandidates).not.toHaveBeenCalled();
 });
 it("retires only eligible candidates",async()=>{
  m.getSilenceRetirementCandidates.mockResolvedValue([candidate(),candidate({rawTask:{id:"t2"},humanTouchAfterCustomer:true}),candidate({rawTask:{id:"t3"},openOpportunities:[{stage:"simulation_sent"}]})]);
  expect(await runSilenceRetirementCheck({} as any,org as any,now)).toBe(1);
  expect(m.retireSilenceTask).toHaveBeenCalledTimes(1);
  expect(m.retireSilenceTask).toHaveBeenCalledWith(expect.anything(),"org",{id:"t1"},expect.stringContaining("7 dias"));
 });
 it("does not count a task a human changed meanwhile and keeps going after an error",async()=>{
  m.getSilenceRetirementCandidates.mockResolvedValue([candidate(),candidate({rawTask:{id:"t2"}})]);
  m.retireSilenceTask.mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce(false);
  expect(await runSilenceRetirementCheck({} as any,org as any,now)).toBe(0);
  expect(m.retireSilenceTask).toHaveBeenCalledTimes(2);
 });
});
