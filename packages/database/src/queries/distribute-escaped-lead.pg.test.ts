// distribute_escaped_lead no PostgreSQL REAL (pglite), com o corpo lido da migração de produção e distribute_lead simulado.
// Garante: a IA só é desligada quando há vendedor; rodízio NULL ou com erro não deixa encaminhamento órfão nem takeover.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ORG = "00000000-0000-4000-8000-000000000001";
const CONV = "00000000-0000-4000-8000-0000000000c1";
const REP = "00000000-0000-4000-8000-0000000000a1";
let pg: PGlite;

function functionDdl(): string {
  const sql = readFileSync(new URL("../../../../supabase/migrations/20261122120000_commitments_followup.sql", import.meta.url), "utf8");
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.distribute_escaped_lead");
  return sql.slice(start, sql.indexOf("END $$;", start) + "END $$;".length);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.conversations (id uuid PRIMARY KEY, organization_id uuid NOT NULL, assigned_to uuid, is_human_takeover boolean NOT NULL DEFAULT false, human_takeover_at timestamptz);
    CREATE TABLE public.handoff_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, conversation_id uuid, trigger_type text, motivo text, resumo text, urgencia text, criado_por text, first_human_reply_at timestamptz);
    CREATE TABLE public.lead_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, handoff_event_id uuid, status text, rep_id uuid, resolved_at timestamptz);
    -- Rodízio simulado: o modo vem desta tabela ('rep' | 'null' | 'exception' | 'error').
    CREATE TABLE public.fake_mode (mode text);
    CREATE FUNCTION public.distribute_lead(p_org uuid, p_conv uuid, p_handoff uuid, p_sla timestamptz, p_ctx jsonb) RETURNS uuid LANGUAGE plpgsql AS $f$
    DECLARE m text; id uuid;
    BEGIN
      SELECT mode INTO m FROM public.fake_mode LIMIT 1;
      IF m = 'null' THEN RETURN NULL; END IF;
      IF m = 'error' THEN RAISE EXCEPTION 'rodizio quebrou'; END IF;
      INSERT INTO public.lead_assignments(conversation_id, handoff_event_id, status, rep_id)
      VALUES (p_conv, p_handoff, CASE WHEN m = 'exception' THEN 'exception' ELSE 'pending' END, CASE WHEN m = 'exception' THEN NULL ELSE '${REP}'::uuid END)
      RETURNING lead_assignments.id INTO id;
      RETURN id;
    END $f$;
  `);
  await pg.exec(functionDdl());
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  await pg.exec(`TRUNCATE public.conversations, public.handoff_events, public.lead_assignments, public.fake_mode;
    INSERT INTO public.conversations(id, organization_id) VALUES ('${CONV}', '${ORG}');`);
});

const mode = (m: string) => pg.query("insert into public.fake_mode(mode) values ($1)", [m]);
const run = async () => (await pg.query<{ r: string | null }>("select public.distribute_escaped_lead($1,$2,now()) as r", [ORG, CONV])).rows[0].r;
const state = async () => ({
  takeover: (await pg.query<{ t: boolean }>("select is_human_takeover t from public.conversations where id=$1", [CONV])).rows[0].t,
  handoffs: (await pg.query("select 1 from public.handoff_events")).rows.length,
  assignments: (await pg.query("select 1 from public.lead_assignments")).rows.length,
});

describe("distribute_escaped_lead", () => {
  it("rodízio entregou a um vendedor: encaminhamento + atribuição + atendimento humano", async () => {
    await mode("rep");
    expect(await run()).toBeTruthy();
    expect(await state()).toEqual({ takeover: true, handoffs: 1, assignments: 1 });
  });
  it("rodízio devolveu NULL: nada fica gravado e a IA continua (sem takeover órfão)", async () => {
    await mode("null");
    expect(await run()).toBeNull();
    expect(await state()).toEqual({ takeover: false, handoffs: 0, assignments: 0 });
  });
  it("rodízio deu erro: a chamada falha inteira e nada fica gravado (a varredura tenta de novo)", async () => {
    await mode("error");
    await expect(run()).rejects.toThrow(/rodizio quebrou/);
    expect(await state()).toEqual({ takeover: false, handoffs: 0, assignments: 0 });
  });
  it("ninguém disponível (exceção para o gestor): encaminhamento e exceção ficam, mas a IA NÃO é desligada", async () => {
    await mode("exception");
    expect(await run()).toBeTruthy();
    expect(await state()).toEqual({ takeover: false, handoffs: 1, assignments: 1 });
  });
  it("já tem dono, atribuição ativa, exceção aberta ou encaminhamento aberto: não faz nada", async () => {
    await mode("rep");
    await pg.query("update public.conversations set assigned_to=$1", [REP]);
    expect(await run()).toBeNull();
    await pg.query("update public.conversations set assigned_to=null");
    await pg.query("insert into public.lead_assignments(conversation_id,status,rep_id) values ($1,'exception',null)", [CONV]);
    expect(await run()).toBeNull();
    await pg.query("truncate public.lead_assignments");
    await pg.query("insert into public.handoff_events(organization_id,conversation_id,trigger_type) values ($1,$2,'request_human')", [ORG, CONV]);
    expect(await run()).toBeNull();
    expect((await state()).takeover).toBe(false);
  });
  it("segunda chamada depois de distribuir: não duplica", async () => {
    await mode("rep");
    await run();
    expect(await run()).toBeNull();
    expect(await state()).toEqual({ takeover: true, handoffs: 1, assignments: 1 });
  });
});
