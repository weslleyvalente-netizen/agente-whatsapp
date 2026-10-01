import {describe,it,expect} from "vitest";
import {decideLowIntentCadence} from "./low-intent-cadence.js";
describe("low intent cadence",()=>{
 it("waits one hour before the first touch",()=>{expect(decideLowIntentCadence(0.9,[])).toBe(null);expect(decideLowIntentCadence(1,[])).toBe(1);});
 it("sends the second touch at 23h after a confirmed first",()=>{expect(decideLowIntentCadence(23,[{stage:1,confirmed:true}])).toBe(2);});
 it("sends the closing message at 48h after two confirmed touches",()=>{expect(decideLowIntentCadence(48,[{stage:1,confirmed:true},{stage:2,confirmed:true}])).toBe(3);});
 it("does not repeat a final closing message",()=>{expect(decideLowIntentCadence(50,[{stage:1,confirmed:true},{stage:2,confirmed:true},{stage:3,confirmed:true}])).toBe(null);});
 it("blocks an ambiguous pending delivery",()=>{expect(decideLowIntentCadence(48,[{stage:1,confirmed:false}])).toBe(null);});
 it("does not replay old overdue touches",()=>{expect(decideLowIntentCadence(49,[])).toBe(null);});
});
