import {it,expect} from "vitest";
import {updateTask} from "./tasks.js";
it("não sobrescreve retorno congelado quando a tarefa mudou após a leitura",async()=>{
 const row:any={id:"task",updated_at:"new",consolidated_pendencies:[{type:"scheduled_callback",freeze_opportunity_id:"opp"}]};
 const db={from:()=>{const filters:Record<string,unknown>={};let patch:any;const q:any={update:(v:any)=>{patch=v;return q},eq:(k:string,v:unknown)=>{filters[k]=v;return q},select:()=>q,single:async()=>{if(Object.entries(filters).some(([k,v])=>row[k]!==v))return {data:null,error:{code:"PGRST116"}};Object.assign(row,patch);return {data:row,error:null}}};return q}};
 await expect(updateTask(db as any,"task",{consolidated_pendencies:[]},"old")).rejects.toThrow("A tarefa mudou");
 expect(row.consolidated_pendencies).toHaveLength(1);
});
