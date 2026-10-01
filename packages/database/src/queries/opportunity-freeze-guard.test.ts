import {it,expect} from "vitest";
import {hasFrozenContact,shouldCancelPreFreezeAgentMessage} from "./opportunity-freeze.js";
function db(rows:unknown[]){const q:any={select:()=>q,eq:()=>q,then:(resolve:any)=>Promise.resolve({data:rows,error:null}).then(resolve)};return {from:()=>q} as any;}
it("protege negócios sem vínculo claro e não reinicia cadência ao vencer",async()=>{
 const client=db([{id:"a",frozen_until:"2026-10-10"},{id:"b",frozen_until:null}]);
 expect(await hasFrozenContact(client,"org","contact",false,"2026-10-01")).toBe(true);
 expect(await hasFrozenContact(client,"org","contact",false,"2026-10-10")).toBe(false);
 expect(await hasFrozenContact(client,"org","contact",true,"2026-10-10")).toBe(true);
});

it("invalidação do job antigo permanece após descongelar",async()=>{expect(await shouldCancelPreFreezeAgentMessage(db([{frozen_at:"2026-10-01T12:00:00Z",frozen_until:null}]),"org","p","2026-10-01T10:00:00Z")).toBe(true)});
