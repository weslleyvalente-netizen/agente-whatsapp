// Homologação local: aplica as migrações REAIS de supabase/migrations num Postgres embutido (PGlite) e expõe um cliente com a
// mesma interface do supabase-js (subconjunto que o código usa), para rodar as funções de produção contra o esquema real
// (constraints, gatilhos, jsonb, updated_at). Só substitui o que o PGlite não tem: vector (vira real[]), auth e storage.
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);

// Texto cru do PG como o PostgREST entrega: datas "YYYY-MM-DD", horas "HH:MM:SS", timestamptz ISO com microssegundos preservados.
const parsers = {
  1082: (v: string) => v,
  1083: (v: string) => v,
  1114: (v: string) => v.replace(" ", "T"),
  1184: (v: string) => v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"),
};

export async function createRealSchemaDb() {
  const pg = new PGlite({ parsers } as any);
  await pg.exec(`
    create schema if not exists extensions; create domain extensions.vector as real[]; create domain public.vector as real[];
    create or replace function extensions.uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;
    create publication supabase_realtime;
    set search_path to public, extensions;
    create schema if not exists auth; create table auth.users(id uuid primary key default gen_random_uuid(), email text);
    create or replace function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create or replace function auth.role() returns text language sql as $$ select 'service_role'::text $$;
    create role authenticated; create role anon; create role service_role;
    create schema if not exists storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text);
  `);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !f.startsWith("00001_")).sort();
  const failed: string[] = [];
  for (const f of files) {
    const sql = readFileSync(new URL(f, MIGRATIONS_DIR), "utf8").replace(/vector\(\d+\)/g, "real[]").replace(/create index[^;]*using (hnsw|ivfflat)[^;]*;/gi, "");
    try { await pg.exec(sql); } catch (e) { try { await pg.exec("ROLLBACK"); } catch { /* sem transação aberta */ } failed.push(`${f}: ${(e as Error).message}`); }
  }
  return { pg, client: postgrestLite(pg) as any, failedMigrations: failed, appliedMigrations: files.length - failed.length };
}

type Cond = { sql: string; params: unknown[] };
// Aceita o caminho JSON do PostgREST: settings->>chave  =>  "settings"->>'chave'
const q = (c: string) => {
  const m = /^([\w]+)(->>?)([\w]+)$/.exec(c);
  return m ? `"${m[1]}"${m[2]}'${m[3]}'` : `"${c.replace(/"/g, "")}"`;
};
const jsonParam = (v: unknown) => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);

export function postgrestLite(pg: PGlite) {
  function from(table: string) {
    const conds: Cond[] = []; let cols = "*"; let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Record<string, unknown> | Record<string, unknown>[] | undefined; let selectAfterWrite = false; let head = false; let wantCount = false;
    const orderBy: string[] = []; let lim: number | null = null; let off = 0;
    const add = (sql: string, ...params: unknown[]) => conds.push({ sql, params });
    const b: any = {
      select(c = "*", o?: { count?: string; head?: boolean }) { cols = c; if (mode !== "select") selectAfterWrite = true; head = !!o?.head; wantCount = !!o?.count; return b; },
      eq: (c: string, v: unknown) => (add(`${q(c)} = ?`, v), b), neq: (c: string, v: unknown) => (add(`${q(c)} <> ?`, v), b),
      gt: (c: string, v: unknown) => (add(`${q(c)} > ?`, v), b), gte: (c: string, v: unknown) => (add(`${q(c)} >= ?`, v), b),
      lt: (c: string, v: unknown) => (add(`${q(c)} < ?`, v), b), lte: (c: string, v: unknown) => (add(`${q(c)} <= ?`, v), b),
      like: (c: string, v: string) => (add(`${q(c)} like ?`, v), b), ilike: (c: string, v: string) => (add(`${q(c)} ilike ?`, v), b),
      in(c: string, vs: unknown[]) { if (!vs.length) add("false"); else add(`${q(c)} in (${vs.map(() => "?").join(",")})`, ...vs); return b; },
      is(c: string, v: unknown) { add(v === null ? `${q(c)} is null` : `${q(c)} is ${v}`); return b; },
      not(c: string, op: string, v: unknown) {
        if (op === "is") add(v === null ? `${q(c)} is not null` : `${q(c)} is not ${v}`);
        else if (op === "in") { const vs = String(v).replace(/^\(|\)$/g, "").split(","); add(`${q(c)} not in (${vs.map(() => "?").join(",")})`, ...vs); }
        else throw new Error(`not.${op} não suportado`);
        return b;
      },
      filter(c: string, op: string, v: string) { if (op !== "cs") throw new Error(`filter ${op} não suportado`); add(`${q(c)} @> ?::jsonb`, v); return b; },
      or(expr: string) {
        const parts = expr.split(",").map((p) => {
          const [c, op, ...rest] = p.split("."); const v = rest.join(".");
          if (op === "eq") return { sql: `${q(c)} = ?`, v, has: true };
          if (op === "is" && v === "null") return { sql: `${q(c)} is null`, v: null, has: false };
          throw new Error(`or ${op} não suportado`);
        });
        add(`(${parts.map((p) => p.sql).join(" or ")})`, ...parts.filter((p) => p.has).map((p) => p.v));
        return b;
      },
      order(c: string, o?: { ascending?: boolean }) { orderBy.push(`${q(c)} ${o?.ascending === false ? "desc" : "asc"}`); return b; },
      limit(n: number) { lim = n; return b; },
      range(a: number, z: number) { off = a; lim = z - a + 1; return b; },
      insert(row: any) { mode = "insert"; payload = row; return b; },
      update(row: any) { mode = "update"; payload = row; return b; },
      delete() { mode = "delete"; return b; },
      single: () => run("single"), maybeSingle: () => run("maybe"),
      then(res: any, rej: any) { return run("many").then(res, rej); },
    };
    async function run(shape: "many" | "single" | "maybe") {
      let sql: string; let params: unknown[] = [];
      const where = () => {
        if (!conds.length) return "";
        let n = params.length; const parts = conds.map((c) => c.sql.replace(/\?/g, () => `$${++n}`));
        params = params.concat(conds.flatMap((c) => c.params.map(jsonParam)));
        return ` where ${parts.join(" and ")}`;
      };
      try {
        if (mode === "insert") {
          const rows = Array.isArray(payload) ? payload : [payload!]; const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
          const vals = rows.map((r) => `(${keys.map((k) => { params.push(jsonParam(r[k] === undefined ? null : r[k])); return `$${params.length}`; }).join(",")})`);
          sql = `insert into public.${q(table)} (${keys.map(q).join(",")}) values ${vals.join(",")} returning *`;
        } else if (mode === "update") {
          const keys = Object.keys(payload as object);
          const sets = keys.map((k) => { params.push(jsonParam((payload as any)[k])); return `${q(k)} = $${params.length}`; });
          sql = `update public.${q(table)} set ${sets.join(",")}${where()} returning *`;
        } else if (mode === "delete") sql = `delete from public.${q(table)}${where()} returning *`;
        else {
          const w = where(); const ord = orderBy.length ? ` order by ${orderBy.join(",")}` : "";
          sql = `select ${head ? "count(*) as __c" : cols} from public.${q(table)}${w}${head ? "" : ord}${lim !== null && !head ? ` limit ${lim} offset ${off}` : ""}`;
        }
        const res = await pg.query<any>(sql, params);
        if (head) return { data: null, error: null, count: Number(res.rows[0].__c) };
        const rows = res.rows; const count = wantCount ? rows.length : null;
        const visible = mode === "select" || selectAfterWrite;
        if (shape === "many") return { data: visible ? rows : null, error: null, count };
        if (!visible) return { data: null, error: null };
        if (rows.length === 1) return { data: rows[0], error: null };
        if (rows.length === 0 && shape === "maybe") return { data: null, error: null };
        return { data: null, error: { code: "PGRST116", message: `${rows.length} rows` } };
      } catch (e: any) { return { data: null, error: { code: e.code ?? "XX000", message: e.message }, count: null }; }
    }
    return b;
  }
  return { from, rpc: async () => { throw new Error("rpc não suportado"); } };
}
