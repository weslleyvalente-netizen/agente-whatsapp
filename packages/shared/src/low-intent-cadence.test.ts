import {describe,it,expect} from "vitest";
import {decideLowIntentCadence} from "./low-intent-cadence.js";
describe("low intent cadence",()=>{
 it("waits one hour before the first touch",()=>{expect(decideLowIntentCadence(0.9,[])).toBe(null);expect(decideLowIntentCadence(1,[])).toBe(1);});
 it("sends the second touch at 23h after a confirmed first",()=>{expect(decideLowIntentCadence(23,[{stage:1,confirmed:true}])).toBe(2);});
 it("sends the closing message one hour after the second confirmed touch",()=>{expect(decideLowIntentCadence(24,[{stage:1,confirmed:true},{stage:2,confirmed:true,sentAtHours:23}],1)).toBe(3);});
 it("does not repeat a final closing message",()=>{expect(decideLowIntentCadence(50,[{stage:1,confirmed:true},{stage:2,confirmed:true},{stage:3,confirmed:true}])).toBe(null);});
 it("blocks an ambiguous pending delivery",()=>{expect(decideLowIntentCadence(48,[{stage:1,confirmed:false}])).toBe(null);});
 it("does not replay old overdue touches",()=>{expect(decideLowIntentCadence(49,[])).toBe(null);});
});

it("espera o intervalo configurado após o retorno efetivo, mesmo quando saiu atrasado",()=>{
 expect(decideLowIntentCadence(25,[{stage:1,confirmed:true},{stage:2,confirmed:true,sentAtHours:24.5}],1)).toBe(null);
 expect(decideLowIntentCadence(26.5,[{stage:1,confirmed:true},{stage:2,confirmed:true,sentAtHours:24.5}],2)).toBe(3);
});
