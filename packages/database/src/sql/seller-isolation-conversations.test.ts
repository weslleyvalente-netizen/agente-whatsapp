// packages/database/src/sql/seller-isolation-conversations.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { asUser, createRlsDb, seedWorld, visible, type World } from "./rls-harness.js";

let db: Awaited<ReturnType<typeof createRlsDb>>; let w: World;
beforeEach(async () => {
  db = await createRlsDb();
  w = await seedWorld(db);
  // dependentes (qualificação, eventos, handoff, notas, marcador de leitura) para cada conversa da organização
  for (const c of [w.conv.marina, w.conv.marcio, w.conv.none, w.conv.legacy]) {
    const qid = (await db.query<any>("insert into public.conversation_qualifications(organization_id,conversation_id) values ($1,$2) returning id", [w.org, c])).rows[0].id;
    await db.query("insert into public.conversation_qualification_events(organization_id,conversation_qualification_id) values ($1,$2)", [w.org, qid]);
    await db.query("insert into public.handoff_events(organization_id,conversation_id) values ($1,$2)", [w.org, c]);
    await db.query("insert into public.conversation_notes(organization_id,conversation_id,user_id) values ($1,$2,$3)", [w.org, c, w.users.manager]);
  }
});

describe("conversations", () => {
  it("o Márcio não vê as conversas da Marina; vê as dele, as sem dono e as do dono legado", async () => {
    expect(await visible(db, w.users.marcio, "conversations")).toEqual([w.conv.marcio, w.conv.none, w.conv.legacy, w.conv.both2].sort());
  });
  it("a Marina não vê as do Márcio", async () => {
    expect(await visible(db, w.users.marina, "conversations")).toEqual([w.conv.marina, w.conv.none, w.conv.legacy, w.conv.both1].sort());
  });
  it("o gestor vê todas da organização e nenhuma de outra", async () => {
    const ids = await visible(db, w.users.manager, "conversations");
    expect(ids).toEqual([w.conv.marina, w.conv.marcio, w.conv.none, w.conv.legacy, w.conv.both1, w.conv.both2].sort());
  });
  it("outra organização nunca aparece, nem para o gestor", async () => {
    for (const u of [w.users.manager, w.users.marina]) expect(await visible(db, u, "conversations")).not.toContain(w.conv.otherOrg);
    expect(await visible(db, w.users.otherOrgUser, "conversations")).toEqual([w.conv.otherOrg]);
  });
  it("o vendedor não altera nem apaga conversa que não vê (0 linhas afetadas)", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.conversations set status='closed' where id=$1", [w.conv.marina])).affectedRows).toBe(0);
      expect((await db.query("delete from public.conversations where id=$1", [w.conv.marina])).affectedRows).toBe(0);
    });
    expect((await db.query<any>("select status from public.conversations where id=$1", [w.conv.marina])).rows[0].status).toBe("open");
  });
  it("o vendedor altera a própria conversa, mas NÃO a passa para outro vendedor (WITH CHECK)", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.conversations set status='closed' where id=$1", [w.conv.marcio])).affectedRows).toBe(1);
      await expect(db.query("update public.conversations set assigned_to=$2 where id=$1", [w.conv.marcio, w.users.marina])).rejects.toThrow(/row-level security/i);
      // soltar a conversa (sem dono) é permitido: continua visível para ele
      expect((await db.query("update public.conversations set assigned_to=null where id=$1", [w.conv.marcio])).affectedRows).toBe(1);
    });
  });
  it("o gestor consegue transferir a conversa de um vendedor a outro", async () => {
    await asUser(db, w.users.manager, async () => {
      expect((await db.query("update public.conversations set assigned_to=$2 where id=$1", [w.conv.marina, w.users.marcio])).affectedRows).toBe(1);
    });
  });
  it("o vendedor pode assumir uma conversa sem dono (passa a ser dele)", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.conversations set assigned_to=$2 where id=$1", [w.conv.none, w.users.marcio])).affectedRows).toBe(1);
    });
  });
  it("o vendedor não cria conversa já atribuída a outro vendedor", async () => {
    await asUser(db, w.users.marcio, async () => {
      await expect(db.query("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [w.org, w.contacts.none, w.users.marina])).rejects.toThrow(/row-level security/i);
    });
  });
});

describe.each([
  ["messages", "conversation_id"], ["conversation_notes", "conversation_id"], ["conversation_qualifications", "conversation_id"], ["handoff_events", "conversation_id"],
])("%s herda a visibilidade da conversa", (table, col) => {
  it("o Márcio só vê as linhas das conversas que ele vê", async () => {
    const rows = await asUser(db, w.users.marcio, async () => (await db.query<any>(`select ${col} as c from public.${table}`)).rows.map(r => r.c));
    expect(rows).not.toContain(w.conv.marina);
    expect(rows).toContain(w.conv.marcio);
  });
  it("o gestor vê as de todos", async () => {
    const rows = await asUser(db, w.users.manager, async () => (await db.query<any>(`select ${col} as c from public.${table}`)).rows.map(r => r.c));
    expect(rows).toContain(w.conv.marina); expect(rows).toContain(w.conv.marcio);
  });
});

describe("mensagens e dependentes", () => {
  it("o Márcio não lê nem escreve mensagem na conversa da Marina", async () => {
    expect(await visible(db, w.users.marcio, "messages")).not.toContain(w.msg.marina);
    await asUser(db, w.users.marcio, async () => {
      await expect(db.query("insert into public.messages(organization_id,conversation_id,content) values ($1,$2,'x')", [w.org, w.conv.marina])).rejects.toThrow(/row-level security/i);
      expect((await db.query("update public.messages set content='x' where id=$1", [w.msg.marina])).affectedRows).toBe(0);
    });
  });
  it("o Márcio escreve na própria conversa", async () => {
    await asUser(db, w.users.marcio, async () => {
      await db.query("insert into public.messages(organization_id,conversation_id,content) values ($1,$2,'x')", [w.org, w.conv.marcio]);
    });
  });
  it("eventos de qualificação seguem a qualificação (e a conversa)", async () => {
    const rows = await asUser(db, w.users.marcio, async () => (await db.query<any>("select count(*)::int as n from public.conversation_qualification_events")).rows[0].n);
    const all = (await db.query<any>("select count(*)::int as n from public.conversation_qualification_events")).rows[0].n;
    expect(rows).toBe(3); // marcio + none + legacy (marina fica de fora)
    expect(all).toBe(4);
  });
});

describe("conversation_reads (não muda)", () => {
  it("o Márcio não cria marcador de leitura em conversa que não vê e só lê o próprio marcador", async () => {
    await asUser(db, w.users.marcio, async () => {
      await expect(db.query("insert into public.conversation_reads(conversation_id,user_id) values ($1,$2)", [w.conv.marina, w.users.marcio])).rejects.toThrow(/row-level security/i);
      await db.query("insert into public.conversation_reads(conversation_id,user_id) values ($1,$2)", [w.conv.marcio, w.users.marcio]);
      expect((await db.query<any>("select count(*)::int as n from public.conversation_reads")).rows[0].n).toBe(1);
    });
  });
});
