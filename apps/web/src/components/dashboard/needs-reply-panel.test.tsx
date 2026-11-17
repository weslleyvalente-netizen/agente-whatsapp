import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsReplyPanel, type NeedsReplyData } from "./needs-reply-panel";

const item = (id: string, name: string | null, minutes: number, owner: string | null = "u1") => ({ conversationId: id, contactId: `p-${id}`, contactName: name, contactPhone: "5511999990000", ownerUserId: owner, waitingSince: "2026-11-17T08:00:00Z", waitingMinutes: minutes });
const list = (items: ReturnType<typeof item>[], total = items.length) => ({ items, total });
const base = (over: Partial<NeedsReplyData> = {}): NeedsReplyData => ({ enabled: true, ownerNames: {}, awaiting: list([item("a", "Ana Souza", 840), item("b", null, 30)]), newLeads: list([item("c", "Bruno", 4320)]), unowned: null, ...over });
const html = (d: NeedsReplyData) => renderToStaticMarkup(<NeedsReplyPanel data={d} />);

describe("NeedsReplyPanel", () => {
  it("mostra as duas listas, há quanto tempo espera e o link de abrir a conversa", () => {
    const out = html(base());
    expect(out).toContain("Precisam de resposta"); expect(out).toContain("Cliente aguardando resposta"); expect(out).toContain("Lead sem primeiro atendimento");
    expect(out).toContain("Ana Souza"); expect(out).toContain("esperando há 14 h"); expect(out).toContain("esperando há 30 min"); expect(out).toContain("esperando há 3 dias");
    expect(out).toContain('href="/opportunities?conversa=a"');
  });
  it("não mostra bloco 'Sem dono' para vendedor (unowned = null)", () => expect(html(base())).not.toContain("Sem dono"));
  it("gestor vê 'Sem dono' separado e o nome do vendedor em cada linha", () => {
    const out = html(base({ ownerNames: { u1: "Marina" }, unowned: { awaiting: list([item("x", "Sem Dono Silva", 90, null)]), newLeads: list([]) } }));
    expect(out).toContain("Sem dono (visível só para gestores)"); expect(out).toContain("Sem Dono Silva"); expect(out).toContain("Marina");
  });
  it("listas vazias mostram mensagem curta; lista longa informa quantos faltam", () => {
    const out = html(base({ awaiting: list([], 0), newLeads: list([item("c", "Bruno", 10)], 14) }));
    expect(out).toContain("Nenhum cliente aguardando resposta."); expect(out).toContain("+13 mais recentes na fila");
  });
});
