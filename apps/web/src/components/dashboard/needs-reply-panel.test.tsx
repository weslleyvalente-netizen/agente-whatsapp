import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsReplyPanel, type NeedsReplyData } from "./needs-reply-panel";

const item = (id: string, name: string | null, minutes: number, owner: string | null = "u1") => ({ conversationId: id, contactId: `p-${id}`, contactName: name, contactPhone: "5511999990000", ownerUserId: owner, waitingSince: "2026-11-17T08:00:00Z", waitingMinutes: minutes });
const list = (items: ReturnType<typeof item>[], total = items.length, older: ReturnType<typeof item>[] = [], olderTotal = older.length) => ({ items, total, older: { items: older, total: olderTotal } });
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
  it("seção recolhível 'Mais de 7 dias' com contador e a lista; fechada por padrão (<details> sem 'open')", () => {
    const out = html(base({ awaiting: list([item("a", "Ana Souza", 840)], 1, [item("o1", "Cliente Antigo", 20000), item("o2", "Outro Antigo", 15000)], 40) }));
    expect(out).toContain("Mais de 7 dias"); expect(out).toContain(">40<"); expect(out).toContain("<details"); expect(out).not.toContain("<details open");
    expect(out).toContain("Cliente Antigo"); expect(out).toContain("esperando há 13 dias"); expect(out).toContain("+38 mais recentes entre os de mais de 7 dias");
  });
  it("sem casos antigos não renderiza a seção; só antigos mostra 'Nenhum caso de até 7 dias.'", () => {
    expect(html(base())).not.toContain("Mais de 7 dias");
    const out = html(base({ awaiting: list([], 0, [item("o1", "Cliente Antigo", 20000)]) }));
    expect(out).toContain("Nenhum caso de até 7 dias."); expect(out).toContain("Mais de 7 dias");
  });
  it("lista parcial (truncated) avisa que os números são o mínimo; completa não avisa", () => {
    expect(html(base({ truncated: true }))).toContain("Lista parcial");
    expect(html(base({ truncated: false }))).not.toContain("Lista parcial");
    expect(html(base())).not.toContain("Lista parcial");
  });
});
