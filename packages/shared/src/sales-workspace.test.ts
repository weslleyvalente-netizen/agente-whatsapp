import { describe, expect, it } from "vitest";
import { classifySalesCard, sortNewestSalesCards } from "./sales-workspace.js";
const base = { openOpportunityCount: 1, handoff: null, latestRole: "agent", taskCount: 0 };
describe("sales workspace", () => {
 it("routes a commercial handoff without changing its commercial stage", () => {
  expect(classifySalesCard({ ...base, handoff: { motivo: "proposta_pronta", resumo: "Quer aderir", first_human_reply_at: null } })).toMatchObject({ readyForHuman: true, hot: true });
 });
 it("does not route an already answered handoff", () => {
  expect(classifySalesCard({ ...base, handoff: { motivo: "proposta_pronta", resumo: "Quer aderir", first_human_reply_at: "2026-10-01T12:00:00Z" } }).readyForHuman).toBe(false);
 });
 it("does not choose between multiple open businesses", () => {
  expect(classifySalesCard({ ...base, openOpportunityCount: 2, handoff: { motivo: "proposta_pronta", resumo: "Quer aderir", first_human_reply_at: null } })).toMatchObject({ readyForHuman: false, humanPending: true });
 });
 it("does not classify a complaint as purchase intent", () => {
  expect(classifySalesCard({ ...base, handoff: { motivo: "reclamacao", resumo: "Reclamação", first_human_reply_at: null } }).hot).toBe(false);
 });
 it("distinguishes customer responses and tasks", () => {
  expect(classifySalesCard({ ...base, latestRole: "contact", taskCount: 2 })).toMatchObject({ customerReplied: true, taskCount: 2 });
 });
 it("sorts newest first without mutating input", () => {
  const rows = [{ id: "old", created_at: "2026-09-01" }, { id: "new", created_at: "2026-10-01" }];
  expect(sortNewestSalesCards(rows).map(r => r.id)).toEqual(["new", "old"]); expect(rows[0].id).toBe("old");
 });
});
