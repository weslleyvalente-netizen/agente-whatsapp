import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOpenOpportunitiesByContact } from "./opportunities.js";

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
