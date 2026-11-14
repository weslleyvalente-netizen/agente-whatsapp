import { describe, expect, it } from "vitest";
import { createRealSchemaDb } from "./real-schema-db.js";

describe("homologação local: migrações reais", () => {
  it("aplica toda a cadeia de migrações e a tabela tasks tem o esquema real", async () => {
    const { pg, failedMigrations, appliedMigrations } = await createRealSchemaDb();
    expect(failedMigrations).toEqual([]);
    expect(appliedMigrations).toBeGreaterThan(60);
    const c = await pg.query<{ column_name: string }>("select column_name from information_schema.columns where table_name='tasks'");
    expect(c.rows.map((r) => r.column_name)).toEqual(expect.arrayContaining(["consolidated_pendencies", "opportunity_id", "assignee_id", "updated_at"]));
  }, 120_000);
});
