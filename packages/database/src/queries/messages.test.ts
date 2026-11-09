import { describe, it, expect } from "vitest";
import { setMessageEvolutionId, updateMessageContent, getRecentMessages, applyMessageDeliveryStatus } from "./messages.js";

// Minimal fake covering .from("messages").update(...).eq("id", ...).select().single(),
// same style as the inline fakes used elsewhere in this package's query tests.
type Row = Record<string, unknown>;

function makeFakeClient(initialMessages: Row[]) {
  const messages: Row[] = [...initialMessages];

  return {
    from(table: string) {
      if (table !== "messages") throw new Error(`unexpected table ${table}`);
      let filterId: string | undefined;
      let payload: Row | undefined;

      const builder = {
        update(changes: Row) {
          payload = changes;
          return builder;
        },
        eq(col: string, val: unknown) {
          if (col === "id") filterId = val as string;
          return builder;
        },
        select: () => builder,
        async single() {
          const row = messages.find((m) => m.id === filterId);
          if (!row) return { data: null, error: { message: "not found" } };
          Object.assign(row, payload);
          return { data: row, error: null };
        },
      };
      return builder;
    },
  };
}

describe("setMessageEvolutionId", () => {
  it("updates evolution_message_id and returns the updated row", async () => {
    const client = makeFakeClient([
      { id: "msg-1", evolution_message_id: null, content: "oi" },
    ]);

    const result = await setMessageEvolutionId(client as never, "msg-1", "EVO123");

    expect(result).toMatchObject({ id: "msg-1", evolution_message_id: "EVO123" });
  });

  it("throws when the message does not exist", async () => {
    const client = makeFakeClient([]);

    await expect(setMessageEvolutionId(client as never, "missing", "EVO123")).rejects.toThrow();
  });
});

it("persists the transcription timestamp along with its text",async()=>{
 const row:any={id:"audio",content:"[audio]",metadata:{duration_seconds:10}};
 const db:any={from:()=>({update:(payload:any)=>({eq:async(_column:string,id:string)=>{if(id===row.id) Object.assign(row,payload);return {error:null};}})})};
 await updateMessageContent(db,"audio","🎤 Pedi outro CPF",{duration_seconds:10,audio_transcribed_at:"2026-10-01T11:00:00Z"});
 expect(row).toMatchObject({content:"🎤 Pedi outro CPF",metadata:{duration_seconds:10,audio_transcribed_at:"2026-10-01T11:00:00Z"}});
});

it("registra o primeiro instante confirmado da cadência, preservando o eco e os metadados",async()=>{
 const row:any={id:"cadence",evolution_message_id:null,metadata:{source:"automatic_followup",low_intent_followup:{anchor:"start",stage:2}}};
 const db=makeFakeClient([row]);
 await setMessageEvolutionId(db as any,"cadence","EVO");
 expect(row.metadata.low_intent_followup.confirmed_at).toEqual(expect.any(String));
 const first=row.metadata.low_intent_followup.confirmed_at;
 await setMessageEvolutionId(db as any,"cadence","EVO");
 expect(row.metadata.low_intent_followup.confirmed_at).toBe(first);
 expect(row.metadata.source).toBe("automatic_followup");
});

it("o contexto da IA só inclui despedida efetivamente confirmada, sem a pendente/cancelada",async()=>{
 const rows:any[]=[{id:"cancelled",evolution_message_id:"echo",metadata:{scheduled_ad_closure:{cancelled_at:"now"}}},{id:"pending",evolution_message_id:null,metadata:{scheduled_ad_closure:{batch_id:"batch"}}},{id:"confirmed",evolution_message_id:"EVO",metadata:{scheduled_ad_closure:{batch_id:"batch"}}},{id:"legacy",evolution_message_id:null,metadata:null}];
 const q:any={select:()=>q,eq:()=>q,order:()=>q,limit:async()=>({data:structuredClone(rows),error:null})};
 const messages=await getRecentMessages({from:()=>q} as any,"c");
 expect(messages.map(m=>m.id)).toEqual(["legacy","confirmed"]);
});

describe("findExistingEvolutionMessageIds (lote)", () => {
  it("consulta em blocos e junta os ids existentes", async () => {
    const calls: string[][] = [];
    const client = {
      from: () => ({
        select: () => ({
          in: async (_col: string, ids: string[]) => {
            calls.push(ids);
            return { data: ids.filter((i) => i.endsWith("0")).map((i) => ({ evolution_message_id: i })), error: null };
          },
        }),
      }),
    } as never;
    const { findExistingEvolutionMessageIds } = await import("./messages.js");
    const ids = Array.from({ length: 450 }, (_, i) => `id${i}`);
    const found = await findExistingEvolutionMessageIds(client, ids);
    expect(calls.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(found.size).toBe(45);
    expect(found.has("id10")).toBe(true);
    expect(found.has("id11")).toBe(false);
  });
});

describe("applyMessageDeliveryStatus", () => {
  function recorder() {
    const calls: Array<{ payload: Record<string, unknown>; filters: Array<[string, ...unknown[]]> }> = [];
    const client = {
      from: () => {
        const call: { payload: Record<string, unknown>; filters: Array<[string, ...unknown[]]> } = { payload: {}, filters: [] };
        const b: any = {
          update: (p: Record<string, unknown>) => { call.payload = p; calls.push(call); return b; },
          eq: (...a: unknown[]) => { call.filters.push(["eq", ...a]); return b; },
          in: (...a: unknown[]) => { call.filters.push(["in", ...a]); return b; },
          is: (...a: unknown[]) => { call.filters.push(["is", ...a]); return Promise.resolve({ error: null }); },
        };
        return b;
      },
    };
    return { client, calls };
  }

  it("entregue preenche só delivered_at, só se vazio, só para mensagens nossas da organização", async () => {
    const { client, calls } = recorder();
    await applyMessageDeliveryStatus(client as never, { organizationId: "org", evolutionMessageId: "E1", status: "delivered", at: "T" });
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({ delivered_at: "T" });
    expect(calls[0].filters).toEqual(expect.arrayContaining([["eq", "organization_id", "org"], ["eq", "evolution_message_id", "E1"], ["in", "role", ["agent", "human_agent"]], ["is", "delivered_at", null]]));
  });

  it("lida preenche read_at e também delivered_at (sem sobrescrever)", async () => {
    const { client, calls } = recorder();
    await applyMessageDeliveryStatus(client as never, { organizationId: "org", evolutionMessageId: "E1", status: "read", at: "T" });
    expect(calls.map((c) => c.payload)).toEqual([{ read_at: "T" }, { delivered_at: "T" }]);
  });
});
