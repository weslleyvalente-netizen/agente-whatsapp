import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Opportunity } from "@aula-agente/shared";
import { getOpenOpportunitiesByContact, getOpportunitiesByOrganization, OPPORTUNITY_LIST_COLUMNS } from "./opportunities.js";

it("returns freeze dates while keeping organization, contact and open-status filters", async () => {
  const rows = [
    { id: "active", organization_id: "org", contact_id: "contact", status: "open", waiting_on: null, waiting_on_until: null, frozen_until: "2026-10-10" },
    { id: "unfrozen", organization_id: "org", contact_id: "contact", status: "open", waiting_on: "customer", waiting_on_until: "2026-10-05", frozen_until: null },
    { id: "other-org", organization_id: "other", contact_id: "contact", status: "open" },
    { id: "other-contact", organization_id: "org", contact_id: "other", status: "open" },
    { id: "closed", organization_id: "org", contact_id: "contact", status: "won" },
  ];
  let columns: string[] = [];
  const filters: Array<[string, unknown]> = [];
  const query = {
    select(value: string) { columns = value.split(",").map(column => column.trim()); return this; },
    eq(column: string, value: unknown) { filters.push([column, value]); return this; },
    then(resolve: (value: unknown) => unknown) {
      const data = rows.filter(row => filters.every(([column, value]) => (row as Record<string, unknown>)[column] === value))
        .map(row => Object.fromEntries(columns.map(column => [column, (row as Record<string, unknown>)[column]])));
      return Promise.resolve({data, error: null}).then(resolve);
    },
  };
  const db = { from: () => query } as unknown as SupabaseClient;
  expect(await getOpenOpportunitiesByContact(db, "org", "contact")).toEqual([
    {id:"active", waiting_on:null, waiting_on_until:null, frozen_until:"2026-10-10"},
    {id:"unfrozen", waiting_on:"customer", waiting_on_until:"2026-10-05", frozen_until:null},
  ]);
});

it("lista do funil seleciona colunas explícitas, mantém as usadas e deixa de fora os jsonb de congelamento", async () => {
  let selected = "";
  const query: any = { select(value: string) { selected = value; return query; }, eq() { return query; }, order() { return Promise.resolve({ data: [], error: null }); } };
  await getOpportunitiesByOrganization({ from: () => query } as unknown as SupabaseClient, "org", { status: "open" });
  expect(selected).not.toContain("*");
  expect(selected).toContain("wa_contacts(name, phone)");
  const columns = selected.split(",").map(c => c.trim());
  for (const used of ["id", "contact_id", "status", "stage", "operation", "owner_id", "owner_assigned_at", "frozen_until", "freeze_reason", "operation_is_default", "commercial_notes", "next_action_due_date", "waiting_on_until", "last_interaction_at", "created_at", "sale_amount", "credit_amount", "lost_reason"]) expect(columns).toContain(used);
  for (const unused of ["freeze_previous_pendency", "freeze_previous_waiting", "frozen_at"]) expect(columns).not.toContain(unused);
  expect(new Set(OPPORTUNITY_LIST_COLUMNS).size).toBe(OPPORTUNITY_LIST_COLUMNS.length);
});

it("a lista do funil cobre todos os campos do tipo Opportunity (checagem de tipo)", () => {
  const missing: Exclude<keyof Opportunity, (typeof OPPORTUNITY_LIST_COLUMNS)[number]> extends never ? true : false = true;
  expect(missing).toBe(true);
});
