import { describe, it, expect } from "vitest";
import { resolveTaskBucket,computeTaskSummary } from "./task-helpers.js";
import { isOpportunityFrozen, isValidFreezeDate } from "./opportunity-freeze.js";
describe("congelamento", () => {
 it("bloqueia antes do retorno e libera na data, sem depender de flag", () => {
  expect(isOpportunityFrozen({frozen_until:"2026-10-10"}, "2026-10-01")).toBe(true);
  expect(isOpportunityFrozen({frozen_until:"2026-10-10"}, "2026-10-10")).toBe(false);
  expect(isOpportunityFrozen({}, "2026-10-01")).toBe(false);
 });
 it("aceita somente uma data real futura", () => {
  expect(isValidFreezeDate("2026-10-10", "2026-10-01")).toBe(true);
  for(const date of ["2026-10-01","2026-09-30","2026-02-30","abc","2026-13-01"]) expect(isValidFreezeDate(date,"2026-10-01")).toBe(false);
 });
});

it("não apresenta pendências congeladas como atrasadas",()=>{
 const task={type:"awaiting_customer_cpf" as const,status:"pending" as const,due_date:"2026-09-01",completed_at:null,opportunity_frozen_until:"2026-10-10"};
 expect(resolveTaskBucket(task,"2026-10-01")).toBe("upcoming");
 expect(computeTaskSummary([task],"2026-10-01").overdue).toBe(0);
 expect(resolveTaskBucket(task,"2026-10-10")).toBe("today");
 expect(resolveTaskBucket(task,"2026-10-11")).toBe("overdue");
});
