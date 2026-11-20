// Provedor de WhatsApp por instância (20261120140000): 'evolution' (padrão) ou 'uazapi', com o token da instância UAZAPI cifrado.
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./harness.js";

type Db = Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let orgId: string;

beforeEach(async () => {
  db = await createTestDb([]);
  // O fixture não traz evolution_instances: tabela mínima como na 00005.
  await db.exec("CREATE TABLE public.evolution_instances (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), instance_name text NOT NULL, instance_id text NOT NULL UNIQUE)");
  const fs = await import("node:fs");
  await db.exec(fs.readFileSync(new URL("../../../../supabase/migrations/20261120140000_whatsapp_provider.sql", import.meta.url), "utf8"));
  orgId = (await db.query<{ id: string }>("insert into public.organizations default values returning id")).rows[0].id;
});

const insert = async () =>
  (await db.query<{ id: string; provider: string; provider_token_encrypted: string | null }>(
    "insert into public.evolution_instances (organization_id, instance_name, instance_id) values ($1, 'weslley', 'weslley') returning id, provider, provider_token_encrypted", [orgId])).rows[0];

describe("evolution_instances.provider", () => {
  it("instância nova fica em 'evolution' e sem token", async () => {
    expect(await insert()).toMatchObject({ provider: "evolution", provider_token_encrypted: null });
  });

  it("aceita 'uazapi' e recusa outro valor", async () => {
    const { id } = await insert();
    await db.query("update public.evolution_instances set provider = 'uazapi' where id = $1", [id]);
    await expect(db.query("update public.evolution_instances set provider = 'zapi' where id = $1", [id])).rejects.toThrow(/evolution_instances_provider_check/);
  });
});
