import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRlsDb } from "./rls-harness.js";

const M = (f: string) => new URL(`../../../../supabase/migrations/${f}`, import.meta.url);
const MIGRATION = M("20261022120000_won_closes_open_tasks.sql");
const HUMAN_OPENS = M("20261021120000_human_task_opens_opportunity.sql");
const BACKFILL_PREVIEW = M("../backfills/20261022_complete_tasks_of_won_deals_1_preview.sql");
const BACKFILL_APPLY = M("../backfills/20261022_complete_tasks_of_won_deals_2_apply.sql");

// Colunas/constraints de produção (00010, 00024) que o esquema mínimo do rls-fixture não tem.
const SCHEMA = `
  ALTER TABLE public.opportunities ADD COLUMN operation text NOT NULL DEFAULT 'consortium', ADD COLUMN stage text NOT NULL DEFAULT 'interest_received',
    ADD COLUMN initial_operation text NOT NULL DEFAULT 'consortium', ADD COLUMN owner_assigned_at timestamptz, ADD COLUMN last_progress_at timestamptz,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN frozen_until date, ADD CONSTRAINT opp_status_chk CHECK (status IN ('open','won','lost'));
  ALTER TABLE public.tasks ADD COLUMN assignee_type text CHECK (assignee_type IN ('human','ai')), ADD COLUMN type text NOT NULL DEFAULT 'other',
    ADD COLUMN due_date date NOT NULL DEFAULT current_date, ADD COLUMN completed_at timestamptz, ADD COLUMN consolidated_pendencies jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT '2020-01-01', ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD CONSTRAINT tasks_status_chk CHECK (status IN ('pending','in_progress','completed','cancelled','rescheduled')),
    ADD CONSTRAINT tasks_assignee_consistency CHECK ((assignee_type IS NULL AND assignee_id IS NULL) OR (assignee_type = 'ai' AND assignee_id IS NULL) OR (assignee_type = 'human' AND assignee_id IS NOT NULL));
  CREATE FUNCTION public.test_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END $$;
  CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.test_touch_updated_at();
  ALTER TABLE public.wa_contacts ADD COLUMN phone text;
  ALTER TABLE public.opportunity_events ADD COLUMN previous_value jsonb, ADD COLUMN new_value jsonb, ADD COLUMN evidence text NOT NULL, ADD COLUMN changed_by_type text NOT NULL, ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
  ALTER TABLE public.task_events ADD COLUMN note text, ADD COLUMN created_by_id uuid, ADD COLUMN created_by_type text NOT NULL CHECK (created_by_type IN ('ai','human'));
`;
const HUMAN_OPENS_SCHEMA = `
  ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS last_message_at timestamptz; ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
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
  const task = async (o: string, c: string, opts: { status?: string; kind?: "human" | "ai"; opp?: string | null; createdAt?: string } = {}) => {
    const kind = opts.kind ?? "human";
    return (await q("insert into public.tasks(organization_id,contact_id,assignee_type,assignee_id,status,opportunity_id,created_at) values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, clock_timestamp())) returning id",
      [o, c, kind, kind === "human" ? user : null, opts.status ?? "pending", opts.opp ?? null, opts.createdAt ?? null]))[0].id as string;
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
    const prev = ["pending", "in_progress", "rescheduled"];
    for (const [i, t] of ts.entries()) {
      const r = await s.st(t);
      expect(r.status).toBe("completed");
      expect(r.completed_at).not.toBeNull();
      expect(new Date(r.updated_at).getFullYear()).toBeGreaterThan(2020);
      expect(await s.q("select event_type, note, created_by_type, created_by_id from public.task_events where task_id=$1", [t])).toEqual([{ event_type: "completed", note: `Encerrada automaticamente; status anterior: ${prev[i]}; negócio ganho ${o}`, created_by_type: "ai", created_by_id: null }]);
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

  it("negócio congelado que é ganho: tarefa de congelamento fecha, frozen_until fica, nada reabre", async () => {
    const s = await setup();
    const o = await s.opp(s.org, s.contact);
    await s.q("update public.opportunities set frozen_until = current_date + 30 where id=$1", [o]);
    const t = await s.task(s.org, s.contact, { opp: o, status: "pending" });
    await s.q("update public.tasks set consolidated_pendencies = '[{\"type\":\"scheduled_callback\"}]'::jsonb where id=$1", [t]);
    await s.win(o);
    expect((await s.st(t)).status).toBe("completed");
    expect((await s.q("select frozen_until is not null as f from public.opportunities where id=$1", [o]))[0].f).toBe(true);
  });

  it("o gatilho só pega tarefas criadas até o ganho (corte de tempo)", async () => {
    const s = await setup();
    const o = await s.opp(s.org, s.contact);
    const before = await s.task(s.org, s.contact, { opp: o });
    const future = await s.task(s.org, s.contact, { opp: o, createdAt: "2999-01-01" });
    await s.win(o);
    expect((await s.st(before)).status).toBe("completed");
    expect((await s.st(future)).status).toBe("pending");
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

// Executa o arquivo como um operador no editor do Supabase: instrução por instrução (comentários de linha removidos); devolve o resultado de cada uma.
function statements(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter(l => !l.trim().startsWith("--")).join("\n").split(";").map(x => x.trim()).filter(Boolean);
}

describe("backfill 20261022_complete_tasks_of_won_deals (preview e aplicar em arquivos separados)", { timeout: 60_000 }, () => {
  const run = async (s: Awaited<ReturnType<typeof setup>>) => {
    const prev = statements(fileURLToPath(BACKFILL_PREVIEW));
    const app = statements(fileURLToPath(BACKFILL_APPLY));
    expect(prev).toHaveLength(1); // cada arquivo é UMA instrução: nunca preview e aplicar juntos
    expect(app).toHaveLength(1);
    expect(app[0]).toMatch(/^WITH\b/i); // começa com WITH: o editor não acrescenta "limit 100"
    expect([...prev, ...app].join(";")).not.toMatch(/\b(BEGIN|ROLLBACK|COMMIT)\b/i);
    return { preview: () => s.q(prev[0]!), apply: () => s.q(app[0]!) };
  };
  const wonDeal = async (s: Awaited<ReturnType<typeof setup>>, contact: string, daysAgo: number, withEvent = true) => {
    const o = await s.opp(s.org, contact, "won");
    if (withEvent) await s.q("insert into public.opportunity_events(organization_id,opportunity_id,event_type,evidence,changed_by_type,created_at) values ($1,$2,'won','x','human', now() - ($3 || ' days')::interval)", [s.org, o, String(daysAgo)]);
    return o;
  };

  it("preview = dry-run; aplicar conclui o mesmo conjunto, devolve ids e status anterior; reexecutar não faz nada", async () => {
    const s = await setup();
    const { preview, apply } = await run(s);
    const o = await wonDeal(s, s.contact, 10);
    const linked = await s.task(s.org, s.contact, { opp: o, status: "in_progress", createdAt: new Date(Date.now() - 20 * 864e5).toISOString() });
    const loose = await s.task(s.org, s.contact, { kind: "ai", createdAt: new Date(Date.now() - 30 * 864e5).toISOString() });
    const c2 = await s.mkContact();
    await s.opp(s.org, c2); // aberto
    const keep = await s.task(s.org, c2);
    const closed = await s.task(s.org, s.contact, { opp: o, status: "cancelled", createdAt: new Date(Date.now() - 20 * 864e5).toISOString() });
    const rows = await preview();
    expect(rows.map((r: any) => r.task_id).sort()).toEqual([linked, loose].sort());
    expect(rows.find((r: any) => r.task_id === linked)).toMatchObject({ decisao: "CONCLUI", opportunity_id: o, dias_desde_ganho: 10, status_atual: "in_progress" });
    expect(rows[0].tarefa_criada_em).toBeTruthy();
    expect((await s.st(linked)).status).toBe("in_progress"); // preview não altera
    const out = await apply();
    expect(out.map((r: any) => r.task_id).sort()).toEqual([linked, loose].sort());
    expect(out.find((r: any) => r.task_id === linked)).toMatchObject({ opportunity_id: o, previous_status: "in_progress" });
    expect((await s.st(linked)).status).toBe("completed");
    expect((await s.st(keep)).status).toBe("pending");
    expect((await s.st(closed)).status).toBe("cancelled");
    expect(await apply()).toHaveLength(0);
    expect(await preview()).toHaveLength(0);
  });

  it("H1: negócio ganho há 180 dias + tarefa criada hoje (cliente que voltou) continua aberta; criada antes do ganho é concluída", async () => {
    const s = await setup();
    const { preview, apply } = await run(s);
    const o = await wonDeal(s, s.contact, 180);
    const old = await s.task(s.org, s.contact, { createdAt: new Date(Date.now() - 200 * 864e5).toISOString() });
    const fresh = await s.task(s.org, s.contact);
    const freshLinked = await s.task(s.org, s.contact, { opp: o }); // vinculada à mão depois do ganho
    expect((await preview()).map((r: any) => r.task_id)).toEqual([old]);
    expect((await apply()).map((r: any) => r.task_id)).toEqual([old]);
    expect((await s.st(old)).status).toBe("completed");
    expect((await s.st(fresh)).status).toBe("pending");
    expect((await s.st(freshLinked)).status).toBe("pending");
  });

  it("ganho sem evento won é pulado e listado no preview; nada é concluído", async () => {
    const s = await setup();
    const { preview, apply } = await run(s);
    const o = await wonDeal(s, s.contact, 0, false);
    const t = await s.task(s.org, s.contact, { opp: o });
    const rows = await preview();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decisao: "PULA: ganho sem evento won", task_id: null, opportunity_id: o });
    expect(Number(rows[0].tarefas_abertas_do_contato)).toBe(1);
    expect(await apply()).toHaveLength(0);
    expect((await s.st(t)).status).toBe("pending");
  });

  it("contato com 2 negócios ganhos: preview e aplicar nomeiam o ganho mais recente para a tarefa sem negócio", async () => {
    const s = await setup();
    const { preview, apply } = await run(s);
    const older = await wonDeal(s, s.contact, 100), newer = await wonDeal(s, s.contact, 5);
    const t = await s.task(s.org, s.contact, { createdAt: new Date(Date.now() - 200 * 864e5).toISOString() });
    expect((await preview())[0]).toMatchObject({ task_id: t, opportunity_id: newer });
    expect((await apply())[0]).toMatchObject({ task_id: t, opportunity_id: newer });
    expect(older).not.toBe(newer);
    expect((await s.q("select note from public.task_events where task_id=$1", [t]))[0].note).toContain(newer);
  });

  it("a consulta de reversão documentada devolve o status anterior", async () => {
    const s = await setup();
    const { apply } = await run(s);
    const o = await wonDeal(s, s.contact, 3);
    const a = await s.task(s.org, s.contact, { opp: o, status: "rescheduled", createdAt: new Date(Date.now() - 9 * 864e5).toISOString() });
    await apply();
    await s.q(`UPDATE public.tasks t SET status = substring(e.note from 'status anterior: ([a-z_]+)'), completed_at = NULL FROM public.task_events e
      WHERE e.task_id = t.id AND e.event_type = 'completed' AND e.note LIKE 'Encerrada automaticamente; status anterior: %' AND t.status = 'completed'`);
    expect((await s.st(a)).status).toBe("rescheduled");
  });
});
