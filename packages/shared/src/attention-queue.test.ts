import { describe, expect, it } from "vitest";
import { buildAttentionQueue, isAwaitingHumanReply, formatWaiting, type AttentionCandidate } from "./attention-queue.js";

const NOW = new Date("2026-11-17T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const MARINA = "u-marina", MARCIO = "u-marcio";
let n = 0;
const mk = (over: Partial<AttentionCandidate>): AttentionCandidate => ({
  kind: "awaiting", conversation_id: `c${++n}`, contact_id: `p${n}`, contact_name: null, contact_phone: "5511", owner_user_id: MARINA,
  is_human_takeover: false, waiting_since: ago(60), last_contact_at: ago(60), had_human_reply: true, unanswered_contents: ["Ver aí como é que fica?"], ...over,
});
const own = (userId: string) => ({ mode: "own" as const, userId });
const ids = (l: { items: { conversationId: string }[] }) => l.items.map((i) => i.conversationId);

describe("fila 'Precisam de resposta' (regra)", () => {
  it("cliente voltou a escrever com takeover desligado, sem tarefa e sem negócio: aparece", () => {
    const q = buildAttentionQueue([mk({ conversation_id: "voltou", is_human_takeover: false })], { viewer: own(MARINA), now: NOW });
    expect(ids(q.awaiting)).toEqual(["voltou"]);
  });
  it("ordena do mais antigo para o mais recente e informa há quanto tempo espera", () => {
    const q = buildAttentionQueue([
      mk({ conversation_id: "novo", waiting_since: ago(30) }), mk({ conversation_id: "velho", waiting_since: ago(72 * 60) }), mk({ conversation_id: "meio", waiting_since: ago(14 * 60) }),
    ], { viewer: own(MARINA), now: NOW });
    expect(ids(q.awaiting)).toEqual(["velho", "meio", "novo"]);
    expect(q.awaiting.items.map((i) => i.waitingMinutes)).toEqual([4320, 840, 30]);
    expect(formatWaiting(4320)).toBe("3 dias"); expect(formatWaiting(840)).toBe("14 h"); expect(formatWaiting(30)).toBe("30 min");
  });
  it("lead sem primeiro atendimento vai para a segunda lista", () => {
    const q = buildAttentionQueue([mk({ kind: "new_lead", conversation_id: "lead", had_human_reply: false, unanswered_contents: [] })], { viewer: own(MARINA), now: NOW });
    expect(ids(q.newLeads)).toEqual(["lead"]); expect(q.awaiting.total).toBe(0);
  });
  it("mesmo cliente nas duas listas aparece uma vez, como 'aguardando resposta'", () => {
    const q = buildAttentionQueue([
      mk({ kind: "new_lead", conversation_id: "lead", contact_id: "x", waiting_since: ago(5000), had_human_reply: false }),
      mk({ kind: "awaiting", conversation_id: "msg", contact_id: "x", waiting_since: ago(10) }),
    ], { viewer: own(MARINA), now: NOW });
    expect(ids(q.awaiting)).toEqual(["msg"]); expect(q.newLeads.total).toBe(0);
  });
  it("'obrigado' depois de atendimento não reabre a fila; pedido novo reabre", () => {
    const q = buildAttentionQueue([
      mk({ conversation_id: "cortesia", unanswered_contents: ["Obrigado!"] }),
      mk({ conversation_id: "ok", unanswered_contents: ["ok"] }),
      mk({ conversation_id: "pedido", unanswered_contents: ["Obrigado! E qual o valor da entrada?"] }),
      mk({ conversation_id: "numero", unanswered_contents: ["12345678901"] }),
    ], { viewer: own(MARINA), now: NOW });
    expect(ids(q.awaiting).sort()).toEqual(["numero", "pedido"]);
  });
  it("cortesia SEM atendimento anterior continua na fila (cliente nunca foi atendido)", () => {
    expect(isAwaitingHumanReply({ had_human_reply: false, unanswered_contents: ["oi"] })).toBe(true);
  });
  it("conteúdo desconhecido (áudio/imagem sem texto) conta como substantivo", () => {
    expect(isAwaitingHumanReply({ had_human_reply: true, unanswered_contents: ["[audio]"] })).toBe(true);
    expect(isAwaitingHumanReply({ had_human_reply: true, unanswered_contents: null })).toBe(true);
  });
  it("isolamento: vendedor não vê o que é de outro nem o que não tem dono", () => {
    const rows = [mk({ conversation_id: "minha" }), mk({ conversation_id: "do-marcio", owner_user_id: MARCIO }), mk({ conversation_id: "sem-dono", owner_user_id: null }),
      mk({ kind: "new_lead", conversation_id: "lead-marcio", owner_user_id: MARCIO, had_human_reply: false })];
    const q = buildAttentionQueue(rows, { viewer: own(MARINA), now: NOW });
    expect(ids(q.awaiting)).toEqual(["minha"]); expect(q.newLeads.total).toBe(0); expect(q.unowned).toBeNull();
  });
  it("gestor vê todos os vendedores e os sem dono separados", () => {
    const rows = [mk({ conversation_id: "a" }), mk({ conversation_id: "b", owner_user_id: MARCIO }), mk({ conversation_id: "sem", owner_user_id: null, is_human_takeover: true }),
      mk({ kind: "new_lead", conversation_id: "lead-sem-dono", owner_user_id: null, had_human_reply: false })];
    const q = buildAttentionQueue(rows, { viewer: { mode: "all" }, now: NOW });
    expect(ids(q.awaiting).sort()).toEqual(["a", "b"]);
    expect(ids(q.unowned!.awaiting)).toEqual(["sem"]); expect(ids(q.unowned!.newLeads)).toEqual(["lead-sem-dono"]);
  });
  it("lista curta: mostra até o limite e informa o total", () => {
    const rows = Array.from({ length: 14 }, (_, i) => mk({ conversation_id: `k${i}`, waiting_since: ago(100 + i) }));
    const q = buildAttentionQueue(rows, { viewer: own(MARINA), now: NOW, limit: 10 });
    expect(q.awaiting.items).toHaveLength(10); expect(q.awaiting.total).toBe(14); expect(ids(q.awaiting)[0]).toBe("k13");
  });
});
