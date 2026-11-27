// Migração 20261127120000: novos tipos de condição do monitor do provedor na tabela de alertas existente. Só amplia a CHECK.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seedOrg } from "./harness.js";

const M = (f: string) => readFileSync(new URL(`../../../../supabase/migrations/${f}`, import.meta.url), "utf8");
type Db = Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let org: string;
const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
const insert = (kind: string, instance = "weslley", mode = "shadow") =>
  q("insert into public.silent_connection_alerts(organization_id, instance_name, kind, mode) values ($1,$2,$3,$4) returning id", [org, instance, kind, mode]);

beforeEach(async () => {
  db = await createTestDb();
  await db.exec(M("20261117180000_silent_connection_alerts.sql"));
  org = await seedOrg(db, {});
});

describe("tipos de alerta do monitor do provedor", () => {
  it("antes da migração, os tipos novos são recusados (prova de que a migração é necessária)", async () => {
    await expect(insert("provider_ahead")).rejects.toThrow(/check/i);
  });

  it("depois da migração: tipos novos aceitos, antigos continuam válidos, tipo inválido recusado", async () => {
    await db.exec(M("20261127120000_provider_health_alert_kinds.sql"));
    for (const k of ["provider_disconnected", "provider_ahead", "webhook_stalled", "silent_connection", "monitor_blind", "push_not_ready"]) await insert(k);
    await insert("queue_backlog", "*");
    await expect(insert("qualquer_coisa")).rejects.toThrow(/check/i);
  });

  it("continua um único alerta ABERTO por instância, tipo e modo (trava contra aviso duplicado)", async () => {
    await db.exec(M("20261127120000_provider_health_alert_kinds.sql"));
    await insert("webhook_stalled");
    await expect(insert("webhook_stalled")).rejects.toThrow(/duplicate|unique/i);
    await insert("webhook_stalled", "weslley", "on"); // outro modo: permitido
  });

  it("é idempotente (aplicar duas vezes não quebra) e não altera linhas existentes", async () => {
    await insert("silent_connection");
    await db.exec(M("20261127120000_provider_health_alert_kinds.sql"));
    await db.exec(M("20261127120000_provider_health_alert_kinds.sql"));
    expect(await q("select kind from public.silent_connection_alerts")).toEqual([{ kind: "silent_connection" }]);
    expect(await q("select count(*)::int n from pg_constraint where conrelid='public.silent_connection_alerts'::regclass and contype='c' and pg_get_constraintdef(oid) ~ 'kind'")).toEqual([{ n: 1 }]);
  });
});
