import { describe, expect, it, vi } from "vitest";
import { loadNeedsReply } from "./needs-reply-loader";

const org = (settings: Record<string, unknown>) => ({ id: "org-1", settings });
const piloto = { needs_reply_queue_enabled: true, needs_reply_queue_user_ids: ["marina", "marcio"] };

describe("loadNeedsReply (chamada à fila só no piloto)", () => {
  it("flag desligada ou ausente: nenhuma chamada", async () => {
    const f = vi.fn();
    expect(await loadNeedsReply(org({}), "marina", f)).toBeNull();
    expect(await loadNeedsReply(org({ ...piloto, needs_reply_queue_enabled: false }), "marina", f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it("usuário fora do piloto, sem lista ou ainda sem usuário carregado: nenhuma chamada", async () => {
    const f = vi.fn();
    expect(await loadNeedsReply(org(piloto), "outro", f)).toBeNull();
    expect(await loadNeedsReply(org({ needs_reply_queue_enabled: true }), "marina", f)).toBeNull();
    expect(await loadNeedsReply(org(piloto), null, f)).toBeNull();
    expect(await loadNeedsReply(null, "marina", f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it("usuário do piloto: exatamente 1 chamada por montagem (a cada volta de uma conversa há uma nova), devolve os dados", async () => {
    const data = { enabled: true, awaiting: { items: [], total: 0, older: { items: [], total: 0 } } };
    const f = vi.fn().mockResolvedValue(data);
    expect(await loadNeedsReply(org(piloto), "marina", f)).toBe(data);
    expect(f).toHaveBeenCalledTimes(1); expect(f).toHaveBeenCalledWith("/organizations/org-1/dashboard/needs-reply");
    await loadNeedsReply(org(piloto), "marina", f); expect(f).toHaveBeenCalledTimes(2); // nova montagem = nova consulta (atualiza depois de uma resposta humana)
  });
  it("backend responde enabled=false ou dá erro: null (volta para 'Tarefas urgentes')", async () => {
    expect(await loadNeedsReply(org(piloto), "marina", vi.fn().mockResolvedValue({ enabled: false }))).toBeNull();
    expect(await loadNeedsReply(org(piloto), "marina", vi.fn().mockRejectedValue(new Error("500")))).toBeNull();
  });
});
