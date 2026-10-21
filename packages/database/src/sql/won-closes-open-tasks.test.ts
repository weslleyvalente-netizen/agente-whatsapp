import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRlsDb } from "./rls-harness.js";

const M = (f: string) => new URL(`../../../../supabase/migrations/${f}`, import.meta.url);
const MIGRATION = M("20261022120000_won_closes_open_tasks.sql");
const HUMAN_OPENS = M("20261021120000_human_task_opens_opportunity.sql");
const BACKFILL = M("../backfills/20261022_complete_tasks_of_won_deals.sql");

// Colunas/constraints de produção (00010, 00024) que o esquema mínimo do rls-fixture não tem.
const SCHEMA = `
  ALTER TABLE public.opportunities ADD COLUMN operation text NOT NULL DEFAULT 'consortium', ADD COLUMN stage text NOT NULL DEFAULT 'interest_received',
    ADD COLUMN initial_operation text NOT NULL DEFAULT 'consortium', ADD COLUMN owner_assigned_at timestamptz, ADD COLUMN last_progress_at timestamptz,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD CONSTRAINT opp_status_chk CHECK (status IN ('open','won','lost'));
  ALTER TABLE public.tasks ADD COLUMN assignee_type text CHECK (assignee_type IN ('human','ai')), ADD COLUMN type text NOT NULL DEFAULT 'other',
    ADD COLUMN due_date date NOT NULL DEFAULT current_date, ADD COLUMN completed_at timestamptz,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT '2020-01-01', ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD CONSTRAINT tasks_status_chk CHECK (status IN ('pending','in_progress','completed','cancelled','rescheduled')),
    ADD CONSTRAINT tasks_assignee_consistency CHECK ((assignee_type IS NULL AND assignee_id IS NULL) OR (assignee_type = 'ai' AND assignee_id IS NULL) OR (assignee_type = 'human' AND assignee_id IS NOT NULL));
  CREATE FUNCTION public.test_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END $$;
  CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.test_touch_updated_at();
  ALTER TABLE public.wa_contacts ADD COLUMN phone text;
  ALTER TABLE public.opportunity_events ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT clock_timestamp();
  ALTER TABLE public.task_events ADD COLUMN note text, ADD COLUMN created_by_id uuid, ADD COLUMN created_by_type text NOT NULL CHECK (created_by_type IN ('ai','human'));
`;
const HUMAN_OPENS_SCHEMA = `
  ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS last_message_at timestamptz; ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE public.opportunity_events ADD COLUMN previous_value jsonb, ADD COLUMN new_value jsonb, ADD COLUMN evidence text NOT NULL, ADD COLUMN changed_by_type text NOT NULL;
  CREATE TABLE public.organization_ignored_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), phone text NOT NULL);
`;

async function setup({ withHumanOpens = false, apply = true } = {}) {
  const db = await createRlsDb([]);
  await db.exec(SCHEMA);
  if (withHumanOpens) { await db.exec(HUMAN_OPENS_SCHEMA); await db.exec(readFileSync(HUMAN_OPENS, "utf8")); }
  if (apply) await db.exec(readFileSync(MIGRATION, "utf8"));
  const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
  const mkOrg = async () => (await q("insert into public.organizations(settings) values ('{\"sales_auto_pipeline_enabled\": true}') returning id"))[0].id as string;
  const org = await mkOrg(), other = await mkOrg();
  const mkContact = async (o = org, phone = String(Math.random())) => (await q("insert into public.wa_contacts(organization_id,phone) values ($1,$2) returning id", [o, phone]))[0].id as string;
  const contact = await mkContact();
  const user = crypto.randomUUID();
  const opp = async (o: string, c: string, status = "open") => (await q("insert into public.opportunities(organization_id,contact_id,status) values ($1,$2,$3) returning id", [o, c, status]))[0].id as string;
  const task = async (o: string, c: string, opts: { status?: string; kind?: "human" | "ai"; opp?: string | null } = {}) => {
    const kind = opts.kind ?? "human";
    return (await q("insert into public.tasks(organization_id,contact_id,assignee_type,assignee_id,status,opportunity_id) values ($1,$2,$3,$4,$5,$6) returning id",
      [o, c, kind, kind === "human" ? user : null, opts.status ?? "pending", opts.opp ?? null]))[0].id as string;
  };
  const st = async (t: string) => (await q("select status, completed_at, updated_at from public.tasks where id=$1", [t]))[0];
  const win = (id: string) => q("update public.opportunities set status='won' where id=$1", [id]);
  return { db, q, org, other, contact, user, opp, task, st, win, mkContact, mkOrg };
}

describe("won_closes_open_tasks", { timeout: 60_000 }, () => {
  it("conclui tarefas abertas ligadas ao negócio (humanas e da IA, os três status abertos) com completed_at, updated_at e task_event", async () => {
    const s = await setup();
    const o = await s.opp(s.org, s.contact);
    const ts = [await s.task(s.org, s.contact, { opp: o, status: "pending" }), await s.task(s.org, s.contact, { opp: o, status: "in_progress", kind: "ai" }), await s.task(s.org, s.contact, { opp: o, status: "rescheduled" })];
    await s.win(o);
    for (const t of ts) {
      const r = await s.st(t);
      expect(r.status).toBe("completed");
      expect(r.completed_at).not.toBeNull();
      expect(new Date(r.updated_at).getFullYear()).toBeGreaterThan(2020);
      expect(await s.q("select event_type, note, created_by_type, created_by_id from public.task_events where task_id=$1", [t])).toEqual([{ event_type: "completed", note: `Encerrada automaticamente: negócio ${o} ganho`, created_by_type: "ai", created_by_id: null }]);
    }
  });

  it("tarefas sem negócio do contato: concluídas só se não há outro negócio aberto", async () => {
    let s = await setup();
    let o = await s.opp(s.org, s.contact);
    let t = await s.task(s.org, s.contact);
    await s.win(o);
    expect((await s.st(t)).status).toBe("completed");

    s = await setup();
    o = await s.opp(s.org, s.contact);
    await s.opp(s.org, s.contact, "open"); // outro negócio aberto
    t = await s.task(s.org, s.contact);
    await s.win(o);
    expect((await s.st(t)).status).toBe("pending");

    s = await setup(); // outro negócio perdido/ganho não impede
    o = await s.opp(s.org, s.contact);
    await s.opp(s.org, s.contact, "lost");
    t = await s.task(s.org, s.contact, { kind: "ai" });
    await s.win(o);
    expect((await s.st(t)).status).toBe("completed");
  });

  it("com outro negócio aberto, tarefa ligada ao negócio ganho fecha; a ligada ao outro continua", async () => {
    const s = await setup();
    const won = await s.opp(s.org, s.contact), still = await s.opp(s.org, s.contact);
    const a = await s.task(s.org, s.contact, { opp: won }), b = await s.task(s.org, s.contact, { opp: still });
    await s.win(won);
    expect((await s.st(a)).status).toBe("completed");
    expect((await s.st(b)).status).toBe("pending");
  });

  it("não mexe em outro contato, outra organização, tarefas já fechadas nem tarefa ligada a negócio de outro contato", async () => {
    const s = await setup();
    const o = await s.opp(s.org, s.contact);
    const otherContact = await s.mkContact();
    const otherOrgContact = await s.mkContact(s.other);
    const otherContactOpp = await s.opp(s.org, otherContact);
    const untouched = [await s.task(s.org, otherContact), await s.task(s.other, otherOrgContact), await s.task(s.org, otherContact, { opp: otherContactOpp })];
    const done = await s.task(s.org, s.contact, { opp: o, status: "completed" }), cancelled = await s.task(s.org, s.contact, { opp: o, status: "cancelled" });
    await s.q("update public.tasks set completed_at='2026-01-01' where id=$1", [done]);
    await s.win(o);
    for (const t of untouched) expect((await s.st(t)).status).toBe("pending");
    expect((await s.st(done)).status).toBe("completed");
    expect(new Date((await s.st(done)).completed_at).getFullYear()).toBe(2026);
    expect((await s.st(cancelled)).status).toBe("cancelled");
    expect(await s.q("select 1 from public.task_events where task_id in ($1,$2)", [done, cancelled])).toHaveLength(0);
  });

  it("negócio perdido não faz nada; reabrir o negócio não reabre tarefas; salvar de novo um negócio já ganho não faz nada", async () => {
    const s = await setup();
    const lost = await s.opp(s.org, s.contact);
    const t = await s.task(s.org, s.contact, { opp: lost });
    await s.q("update public.opportunities set status='lost' where id=$1", [lost]);
    expect((await s.st(t)).status).toBe("pending");

    const s2 = await setup();
    const o = await s2.opp(s2.org, s2.contact, "won"); // nasce ganho (INSERT): sem efeito, o backfill cuida
    const t2 = await s2.task(s2.org, s2.contact, { opp: o });
    await s2.q("update public.opportunities set stage='proposal' where id=$1", [o]);
    await s2.q("update public.opportunities set status='won' where id=$1", [o]); // won -> won
    expect((await s2.st(t2)).status).toBe("pending");
    await s2.q("update public.opportunities set status='open' where id=$1", [o]);
    await s2.win(o);
    expect((await s2.st(t2)).status).toBe("completed");
    await s2.q("update public.opportunities set status='open' where id=$1", [o]);
    expect((await s2.st(t2)).status).toBe("completed");
  });

  it("UPDATE em lote: vários negócios ganhos de uma vez, dois do mesmo contato (nenhum outro aberto) fecham tudo", async () => {
    const s = await setup();
    const c2 = await s.mkContact();
    const a = await s.opp(s.org, s.contact), b = await s.opp(s.org, s.contact), c = await s.opp(s.org, c2);
    const ts = [await s.task(s.org, s.contact, { opp: a }), await s.task(s.org, s.contact), await s.task(s.org, c2, { opp: c }), await s.task(s.org, c2)];
    await s.q("update public.opportunities set status='won' where id = any($1::uuid[])", [[a, b, c]]);
    for (const t of ts) expect((await s.st(t)).status).toBe("completed");
    expect(await s.q("select 1 from public.task_events")).toHaveLength(4); // um evento por tarefa, sem duplicar
  });

  it("não abre negócio: convive com trg_human_task_opens_opportunity", async () => {
    const s = await setup({ withHumanOpens: true });
    const o = await s.opp(s.org, s.contact);
    const t = await s.task(s.org, s.contact, { opp: o });
    await s.q("update public.tasks set type='consortium_followup' where id=$1", [t]);
    await s.win(o);
    expect((await s.st(t)).status).toBe("completed");
    expect(await s.q("select id from public.opportunities where contact_id=$1", [s.contact])).toHaveLength(1);
    // tarefa nova sem negócio depois do ganho: contato tem histórico, segue sem abrir negócio
    await s.task(s.org, s.contact);
    expect(await s.q("select id from public.opportunities where contact_id=$1", [s.contact])).toHaveLength(1);
  });

  it("editar a tarefa concluída depois não a reabre nem duplica o evento", async () => {
    const s = await setup();
    const o = await s.opp(s.org, s.contact);
    const t = await s.task(s.org, s.contact, { opp: o, status: "in_progress" });
    await s.win(o);
    await s.q("update public.tasks set due_date = current_date + 3 where id=$1", [t]);
    expect((await s.st(t)).status).toBe("completed");
    expect(await s.q("select 1 from public.task_events where task_id=$1", [t])).toHaveLength(1);
  });

  it("aplicar a migration duas vezes é seguro (um gatilho, mesma regra)", async () => {
    const s = await setup();
    await s.db.exec(readFileSync(MIGRATION, "utf8"));
    expect(await s.q("select tgname from pg_trigger where tgname='trg_won_closes_open_tasks'")).toHaveLength(1);
    const o = await s.opp(s.org, s.contact);
    const t = await s.task(s.org, s.contact, { opp: o });
    await s.win(o);
    expect((await s.st(t)).status).toBe("completed");
    expect(await s.q("select 1 from public.task_events where task_id=$1", [t])).toHaveLength(1);
  });
});

describe("backfill 20261022_complete_tasks_of_won_deals", { timeout: 60_000 }, () => {
  it("preview lista só o que seria concluído; aplicar devolve os ids; arquivo termina em ROLLBACK com COMMIT comentado", async () => {
    const s = await setup();
    const sql = readFileSync(BACKFILL, "utf8");
    expect(sql).toMatch(/^ROLLBACK;/m);
    expect(sql).toMatch(/^-- COMMIT;/m);
    const o = await s.opp(s.org, s.contact, "won"); // nasceu ganho: o gatilho de UPDATE não rodou
    const linked = await s.task(s.org, s.contact, { opp: o }), loose = await s.task(s.org, s.contact, { kind: "ai" });
    const c2 = await s.mkContact();
    await s.opp(s.org, c2); // aberto
    const keep = await s.task(s.org, c2);
    const closed = await s.task(s.org, s.contact, { opp: o, status: "cancelled" });
    const preview = sql.slice(sql.indexOf("SELECT DISTINCT"), sql.indexOf("-- ===== 2)"));
    const rows = await s.q(preview);
    expect(rows.map((r: any) => r.task_id).sort()).toEqual([linked, loose].sort());
    expect(rows.find((r: any) => r.task_id === linked)).toMatchObject({ opportunity_id: o, dias_desde_ganho: 0 });
    const apply = sql.split("BEGIN;")[1]!.split("ROLLBACK;")[0]!;
    const out = await s.q(apply);
    expect(out.map((r: any) => r.task_id).sort()).toEqual([linked, loose].sort());
    expect((await s.st(linked)).status).toBe("completed");
    expect((await s.st(keep)).status).toBe("pending");
    expect((await s.st(closed)).status).toBe("cancelled");
    expect(await s.q(apply)).toHaveLength(0); // idempotente
  });
});
