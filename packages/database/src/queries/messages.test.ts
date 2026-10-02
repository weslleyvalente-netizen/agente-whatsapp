import { describe, it, expect } from "vitest";
import { setMessageEvolutionId, updateMessageContent } from "./messages.js";

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
