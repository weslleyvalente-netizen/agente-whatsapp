import { it, expect } from "vitest";
import { freezeOpportunity } from "./opportunity-freeze.js";
it("congela por RPC único com organização e ator, sem gravações separadas", async () => {
 const calls: unknown[]=[];
 const db={rpc:async(name:string,args:unknown)=>{calls.push([name,args]);return {data:{id:"opp"},error:null};}};
 expect(await freezeOpportunity(db as any,{organizationId:"org",opportunityId:"opp",actorId:"user",date:"2026-10-10",reason:"Cliente pediu retorno"})).toEqual({id:"opp"});
 expect(calls).toEqual([["set_opportunity_freeze",{p_organization_id:"org",p_opportunity_id:"opp",p_actor_id:"user",p_until:"2026-10-10",p_reason:"Cliente pediu retorno"}]]);
});
it("propaga falha transacional sem indicar sucesso", async()=>{
 const db={rpc:async()=>({data:null,error:new Error("conflict")})};
 await expect(freezeOpportunity(db as any,{organizationId:"org",opportunityId:"opp",actorId:"user",date:null,reason:"Retomar"})).rejects.toThrow("conflict");
});
