// packages/database/src/sql/attention-queue.test.ts — função de leitura public.attention_queue_candidates (migração 20261117120000)
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seedOrg, seedRep } from "./harness.js";

const MIGRATION = readFileSync(new URL("../../../../supabase/migrations/20261117120000_attention_queue.sql", import.meta.url), "utf8");
let db: Awaited<ReturnType<typeof createTestDb>>;
let org: string; let marina: { repId: string; userId: string };
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeEach(async () => {
  db = await createTestDb();
  // colunas de produção que o esquema mínimo do harness não tem
  await db.exec(`ALTER TABLE public.wa_contacts ADD COLUMN IF NOT EXISTS name text, ADD COLUMN IF NOT EXISTS phone text;
    ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open', ADD COLUMN IF NOT EXISTS last_message_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS metadata jsonb;`);
  await db.exec(MIGRATION);
  org = await seedOrg(db); marina = await seedRep(db, org, "Marina", 1);
});

async function conv(opts: { assigned?: string | null; takeover?: boolean; name?: string } = {}) {
  const contact = (await db.query<{ id: string }>("insert into public.wa_contacts(organization_id,name,phone) values ($1,$2,'5511') returning id", [org, opts.name ?? "Cliente"])).rows[0].id;
  const c = (await db.query<{ id: string }>("insert into public.conversations(organization_id,contact_id,assigned_to,is_human_takeover) values ($1,$2,$3,$4) returning id",
    [org, contact, opts.assigned === undefined ? marina.userId : opts.assigned, opts.takeover ?? false])).rows[0].id;
  return { contact, conversation: c };
}
// Resposta humana (human_agent) só conta como atendimento quando a Evolution aceitou o envio (evolution_message_id preenchido).
// Por padrão a mensagem humana dos testes é "aceita" (id gerado); passe evo = null para simular a que o CRM criou e ainda não foi confirmada.
let evoSeq = 0;
const msg = (conversation: string, role: string, content: string, minutesAgo: number, metadata: object | null = null, evo?: string | null) =>
  db.query("insert into public.messages(organization_id,conversation_id,role,content,created_at,metadata,evolution_message_id) values ($1,$2,$3,$4,$5,$6,$7)",
    [org, conversation, role, content, ago(minutesAgo), metadata ? JSON.stringify(metadata) : null, evo !== undefined ? evo : role === "human_agent" ? `evo-${++evoSeq}` : null]);
const touch = (conversation: string, minutesAgo: number) => db.query("update public.conversations set last_message_at=$2 where id=$1", [conversation, ago(minutesAgo)]);
const run = async (kind?: string) => (await db.query<any>("select * from public.attention_queue_candidates($1,$2,200)", [org, ago(30 * 24 * 60)])).rows.filter((r) => !kind || r.kind === kind);
const ids = (rows: any[]) => rows.map((r) => r.conversation_id).sort();

describe("attention_queue_candidates", () => {
  it("cliente voltou a escrever com takeover desligado, sem tarefa e sem negócio: aparece", async () => {
    const { conversation } = await conv({ takeover: false });
    await msg(conversation, "human_agent", "segue o valor", 600); await msg(conversation, "contact", "Ver aí como é que fica?", 120);
    const rows = await run("awaiting");
    expect(ids(rows)).toEqual([conversation]);
    expect(rows[0].had_human_reply).toBe(true); expect(rows[0].unanswered_contents).toEqual(["Ver aí como é que fica?"]);
  });
  it("resposta humana POSTERIOR à mensagem do cliente tira da fila", async () => {
    const { conversation } = await conv();
    await msg(conversation, "contact", "qual o valor?", 120); await msg(conversation, "human_agent", "R$ 10 mil", 60);
    expect(await run("awaiting")).toHaveLength(0);
  });
  it("resposta humana ANTERIOR ao último pedido do cliente não tira da fila, e a espera conta desde o primeiro sem resposta", async () => {
    const { conversation } = await conv();
    await msg(conversation, "human_agent", "olá", 600); await msg(conversation, "contact", "pode mandar o valor", 300); await msg(conversation, "contact", "e a entrada?", 100);
    const [row] = await run("awaiting");
    expect(row.conversation_id).toBe(conversation);
    expect(Math.round((Date.now() - Date.parse(row.waiting_since)) / 60000)).toBeGreaterThanOrEqual(299);
    expect(row.unanswered_contents).toEqual(["e a entrada?", "pode mandar o valor"]);
  });
  it("resposta automática (IA / follow-up automático) NÃO conta como atendimento humano", async () => {
    const { conversation } = await conv();
    await msg(conversation, "contact", "quero financiar", 200); await msg(conversation, "agent", "Claro! Vou verificar.", 190, { source: "automatic_followup" });
    expect(ids(await run("awaiting"))).toEqual([conversation]);
  });
  it("mensagem humana que FALHOU no envio não conta como resposta", async () => {
    const { conversation } = await conv();
    await msg(conversation, "contact", "quero financiar", 200); await msg(conversation, "human_agent", "claro", 100, { send_failed_at: ago(99) });
    expect(ids(await run("awaiting"))).toEqual([conversation]);
  });
  it("conversa sem dono: só entra com takeover ligado (sem takeover é conversa da IA)", async () => {
    const ia = await conv({ assigned: null, takeover: false }); const humano = await conv({ assigned: null, takeover: true });
    for (const c of [ia, humano]) await msg(c.conversation, "contact", "preciso de ajuda", 90);
    const rows = await run("awaiting");
    expect(ids(rows)).toEqual([humano.conversation]); expect(rows[0].owner_user_id).toBeNull();
  });
  it("conversa fechada ou fora da janela de 30 dias não entra", async () => {
    const fechada = await conv(); const velha = await conv();
    await msg(fechada.conversation, "contact", "oi, preciso de ajuda", 90); await db.query("update public.conversations set status='closed' where id=$1", [fechada.conversation]);
    await msg(velha.conversation, "contact", "preciso de ajuda", 60 * 24 * 40); await touch(velha.conversation, 60 * 24 * 40);
    expect(await run("awaiting")).toHaveLength(0);
  });
  it("outra organização nunca aparece", async () => {
    const other = await seedOrg(db); const contact = (await db.query<{ id: string }>("insert into public.wa_contacts(organization_id,name) values ($1,'X') returning id", [other])).rows[0].id;
    const c = (await db.query<{ id: string }>("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3) returning id", [other, contact, marina.userId])).rows[0].id;
    await db.query("insert into public.messages(organization_id,conversation_id,role,content) values ($1,$2,'contact','oi tudo bem')", [other, c]);
    expect(await run()).toHaveLength(0);
  });
  it("lead sem primeiro atendimento: entra; sai com resposta humana (que enviou) depois da atribuição; falha de envio não tira", async () => {
    const { contact, conversation } = await conv();
    const handoff = (await db.query<{ id: string }>("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,$3) returning id", [org, conversation, ago(300)])).rows[0].id;
    await db.query(`insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,assigned_at,handoff_at,strategy_version)
      values ($1,gen_random_uuid(),$2,$3,$4,$5,'round_robin','pending',$6,$6,'test')`, [org, handoff, contact, conversation, marina.repId, ago(300)]);
    const rows = await run("new_lead");
    expect(ids(rows)).toEqual([conversation]); expect(rows[0].owner_user_id).toBe(marina.userId);
    await msg(conversation, "human_agent", "oi", 100, { send_failed_at: ago(99) });
    expect(await run("new_lead")).toHaveLength(1);
    await msg(conversation, "human_agent", "oi, tudo bem?", 90);
    expect(await run("new_lead")).toHaveLength(0);
  });
  it("só service_role executa; anon e authenticated não", async () => {
    await db.exec("GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role"); // no Supabase o service_role já lê as tabelas; o fixture mínimo não
    await db.exec("SET ROLE authenticated");
    await expect(db.query("select * from public.attention_queue_candidates($1,now(),10,null)", [org])).rejects.toThrow(/permission denied/i);
    await db.exec("RESET ROLE; SET ROLE anon");
    await expect(db.query("select * from public.attention_queue_candidates($1,now(),10,null)", [org])).rejects.toThrow(/permission denied/i);
    await db.exec("RESET ROLE; SET ROLE service_role");
    await expect(db.query("select * from public.attention_queue_candidates($1,now(),10,null)", [org])).resolves.toBeTruthy();
    await db.exec("RESET ROLE");
  });
  it("é somente leitura: não altera nenhuma tabela e não toca em rodízio", async () => {
    const { conversation } = await conv(); await msg(conversation, "contact", "preciso de ajuda", 90);
    const snap = async () => JSON.stringify([(await db.query("select count(*) from public.messages")).rows, (await db.query("select * from public.lead_distribution_state")).rows, (await db.query("select count(*) from public.lead_assignments")).rows]);
    const before = await snap(); await run(); expect(await snap()).toBe(before);
  });
  it("p_owner (vendedor) devolve só o que é dele; null (gestor) devolve tudo, inclusive sem dono", async () => {
    const outro = await seedRep(db, org, "Márcio", 2);
    const minha = await conv(); const dele = await conv({ assigned: outro.userId }); const livre = await conv({ assigned: null, takeover: true });
    for (const c of [minha, dele, livre]) await msg(c.conversation, "contact", "preciso de ajuda com o valor", 90);
    const forOwner = async (owner: string | null) => (await db.query<any>("select * from public.attention_queue_candidates($1,$2,200,$3)", [org, ago(30 * 24 * 60), owner])).rows;
    expect(ids(await forOwner(marina.userId))).toEqual([minha.conversation]);
    expect(ids(await forOwner(outro.userId))).toEqual([dele.conversation]);
    expect(ids(await forOwner(null))).toEqual([minha.conversation, dele.conversation, livre.conversation].sort());
  });

  // ---- janela de 30 dias nas DUAS categorias e limites/contadores ----
  async function lead(conversation: string, contact: string, minutesAgo: number, status = "pending") {
    const handoff = (await db.query<{ id: string }>("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,$3) returning id", [org, conversation, ago(minutesAgo)])).rows[0].id;
    const exc = status === "exception"; // exceção: sem vendedor, motivo da exceção obrigatório (checks da tabela)
    await db.query(`insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,assigned_at,handoff_at,exception_reason,strategy_version)
      values ($1,gen_random_uuid(),$2,$3,$4,$5,$6,$7,$8,$8,$9,'test')`, [org, handoff, contact, conversation, exc ? null : marina.repId, exc ? "exception" : "round_robin", status, ago(minutesAgo), exc ? "no_available_rep" : null]);
  }
  const DIA = 24 * 60;
  it("lead com atribuição ANTIGA (fora dos 30 dias) não entra, nem pendente nem exceção sem resolver; dentro da janela entra", async () => {
    const velho = await conv(); const velhoExc = await conv(); const dentro = await conv(); const limite = await conv();
    await lead(velho.conversation, velho.contact, 40 * DIA); await lead(velhoExc.conversation, velhoExc.contact, 31 * DIA, "exception");
    await lead(dentro.conversation, dentro.contact, 29 * DIA); await lead(limite.conversation, limite.contact, 30 * DIA - 5);
    expect(ids(await run("new_lead"))).toEqual([dentro.conversation, limite.conversation].sort());
  });
  it("a mesma janela vale para as duas categorias: antigo some de ambas, recente aparece em ambas", async () => {
    const velho = await conv(); const novo = await conv();
    await lead(velho.conversation, velho.contact, 40 * DIA); await msg(velho.conversation, "contact", "preciso de ajuda", 40 * DIA); await touch(velho.conversation, 40 * DIA);
    await lead(novo.conversation, novo.contact, 3 * DIA); await msg(novo.conversation, "contact", "preciso de ajuda", 3 * DIA); await touch(novo.conversation, 3 * DIA);
    expect(ids(await run("awaiting"))).toEqual([novo.conversation]); expect(ids(await run("new_lead"))).toEqual([novo.conversation]);
  });
  it("kind_total traz o total da categoria na janela, mesmo quando p_limit corta (e não conta atribuição antiga)", async () => {
    for (let i = 0; i < 5; i++) { const c = await conv(); await msg(c.conversation, "contact", `pedido ${i} de ajuda`, 60 + i * 10); await lead(c.conversation, c.contact, 100 + i); }
    const antigo = await conv(); await lead(antigo.conversation, antigo.contact, 45 * DIA);
    const cut = (await db.query<any>("select * from public.attention_queue_candidates($1,$2,2)", [org, ago(30 * DIA)])).rows;
    const by = (k: string) => cut.filter((r) => r.kind === k);
    expect(by("awaiting")).toHaveLength(2); expect(by("new_lead")).toHaveLength(2);
    expect(by("awaiting").every((r) => Number(r.kind_total) === 5)).toBe(true);
    expect(by("new_lead").every((r) => Number(r.kind_total) === 5)).toBe(true); // 5, não 6: a antiga ficou de fora
    const all = (await db.query<any>("select * from public.attention_queue_candidates($1,$2,200)", [org, ago(30 * DIA)])).rows;
    expect(all.filter((r) => r.kind === "awaiting")).toHaveLength(5); expect(all.filter((r) => r.kind === "new_lead")).toHaveLength(5);
  });

  // ---- resposta humana só conta quando a Evolution aceitou o envio (evolution_message_id) ----
  const confirm = (conversation: string) => db.query("update public.messages set evolution_message_id = 'evo-confirmado-'||id where conversation_id=$1 and role='human_agent' and evolution_message_id is null", [conversation]);
  it("(1) mensagem humana criada no CRM e ainda pendente de envio (sem evolution_message_id) NÃO tira o cliente da fila; quando a Evolution aceita, tira", async () => {
    const { conversation } = await conv();
    await msg(conversation, "contact", "qual o valor da entrada?", 120); await msg(conversation, "human_agent", "já te passo", 60, null, null);
    const [row] = await run("awaiting"); expect(row.conversation_id).toBe(conversation); expect(row.had_human_reply).toBe(false);
    await confirm(conversation);
    expect(await run("awaiting")).toHaveLength(0);
  });
  it("(2) mensagem que falhou e só depois recebeu send_failed_at: fica na fila antes e depois da marca", async () => {
    const { conversation } = await conv();
    await msg(conversation, "contact", "quero financiar", 120); await msg(conversation, "human_agent", "claro", 60, null, null);
    expect(ids(await run("awaiting"))).toEqual([conversation]);                                   // ainda sem marca de falha
    await db.query("update public.messages set metadata = jsonb_build_object('send_failed_at', now()::text) where conversation_id=$1 and role='human_agent'", [conversation]);
    expect(ids(await run("awaiting"))).toEqual([conversation]);                                   // marcada como falha
  });
  it("(3) mensagem aceita pela Evolution tira da fila; (4) resposta enviada pelo celular e sincronizada (já chega com id) também", async () => {
    const aceita = await conv(); const celular = await conv();
    for (const c of [aceita, celular]) await msg(c.conversation, "contact", "pode mandar o valor?", 120);
    await msg(aceita.conversation, "human_agent", "segue o valor", 60, { source: "seller_panel" }, "3EB0AAAA1111");
    await msg(celular.conversation, "human_agent", "te respondi pelo celular", 60, null, "3EB0BBBB2222");
    expect(await run("awaiting")).toHaveLength(0);
  });
  it("mensagem humana pendente antiga + resposta confirmada posterior: usa a confirmada; pendente mais nova que a confirmada não muda nada", async () => {
    const { conversation } = await conv();
    await msg(conversation, "human_agent", "oi", 600, null, null); await msg(conversation, "contact", "e o valor?", 300); await msg(conversation, "human_agent", "R$ 10 mil", 200, null, "3EB0CCCC3333");
    await msg(conversation, "human_agent", "algo mais?", 100, null, null);
    expect(await run("awaiting")).toHaveLength(0);
  });
  it("cortesia depois de um atendimento CONFIRMADO não reabre; depois de um atendimento só pendente, a espera continua desde o 1º pedido sem resposta confirmada", async () => {
    const { conversation } = await conv();
    await msg(conversation, "contact", "pode mandar o valor", 300); await msg(conversation, "human_agent", "vou ver", 200, null, null); await msg(conversation, "contact", "ok obrigado", 100);
    const [row] = await run("awaiting"); expect(row.had_human_reply).toBe(false);
    expect(Math.round((Date.now() - Date.parse(row.waiting_since)) / 60000)).toBeGreaterThanOrEqual(299);
  });
  async function leadAccepted(conversation: string, contact: string, over: { acceptedVia: string | null; status?: string; firstHuman?: boolean; minutesAgo?: number }) {
    const ago_ = over.minutesAgo ?? 300;
    const handoff = (await db.query<{ id: string }>("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,$3) returning id", [org, conversation, ago(ago_)])).rows[0].id;
    await db.query(`insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,assigned_at,handoff_at,accepted_at,accepted_via,first_human_message_at,strategy_version)
      values ($1,gen_random_uuid(),$2,$3,$4,$5,'round_robin',$6,$7,$7,$8,$9,$10,'test')`,
      [org, handoff, contact, conversation, marina.repId, over.status ?? "accepted", ago(ago_), over.acceptedVia ? ago(ago_ - 5) : null, over.acceptedVia, over.firstHuman === false ? null : ago(ago_ - 5)]);
  }
  it("(5) lead cujo first_human_message_at foi preenchido (e o painel marcou como aceito) mas a mensagem não teve envio confirmado: continua sem primeiro atendimento", async () => {
    const pendente = await conv(); const falhou = await conv(); const pend2 = await conv();
    await leadAccepted(pendente.conversation, pendente.contact, { acceptedVia: "first_message" }); await msg(pendente.conversation, "human_agent", "oi, tudo bem?", 295, null, null);
    await leadAccepted(falhou.conversation, falhou.contact, { acceptedVia: "first_message" }); await msg(falhou.conversation, "human_agent", "oi", 295, { send_failed_at: ago(290) }, null);
    await leadAccepted(pend2.conversation, pend2.contact, { acceptedVia: null, status: "pending" }); await msg(pend2.conversation, "human_agent", "oi", 295, null, null); // marco gravado mesmo pendente
    expect(ids(await run("new_lead"))).toEqual([pendente.conversation, falhou.conversation, pend2.conversation].sort());
    await confirm(pendente.conversation);
    expect(ids(await run("new_lead"))).toEqual([falhou.conversation, pend2.conversation].sort());
  });
  it("lead aceito pelo celular (eco já com id) ou com envio aceito sai; aceito pelo botão (sem mensagem) segue como antes: fora da fila; marco sem mensagem nenhuma: fica", async () => {
    const eco = await conv(); const botao = await conv(); const semMsg = await conv(); const aceita = await conv();
    await leadAccepted(eco.conversation, eco.contact, { acceptedVia: "phone_echo" }); await msg(eco.conversation, "human_agent", "olá!", 295, null, "3EB0DDDD4444");
    await leadAccepted(botao.conversation, botao.contact, { acceptedVia: "button", firstHuman: false });
    await leadAccepted(semMsg.conversation, semMsg.contact, { acceptedVia: "first_message" });
    await leadAccepted(aceita.conversation, aceita.contact, { acceptedVia: "first_message" }); await msg(aceita.conversation, "human_agent", "oi", 295, null, "3EB0EEEE5555");
    expect(ids(await run("new_lead"))).toEqual([semMsg.conversation]);
  });
});
