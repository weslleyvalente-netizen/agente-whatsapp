import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  claimPushDedupe: vi.fn(), releasePushDedupe: vi.fn(), sendPushToUser: vi.fn(), isPushConfigured: vi.fn(() => true),
  listPushEnabledOrganizationIds: vi.fn(), listCurrentMemberIds: vi.fn(), deletePushSubscriptionsForUser: vi.fn(), purgePushNotificationLog: vi.fn(),
  listNewAssignmentCandidates: vi.fn(), listCustomerMessageCandidates: vi.fn(), listSlaRiskCandidates: vi.fn(),
}));
vi.mock("@aula-agente/database", () => m);
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getPushNotificationsQueue: () => ({ upsertJobScheduler: vi.fn() }) }));
import { runPushSweep, createPushCursor } from "./push-notifications.js";

const now = new Date("2026-10-17T12:00:00Z");
const cand = (over: Record<string, unknown> = {}) => ({ kind: "assign", organizationId: "o", userId: "u1", dedupeKeys: ["assign:a1"], title: "Novo lead: Ana", body: "b", url: "/inbox?id=c", tag: "c", ...over });
const db = {} as any;
const list = (candidates: unknown[], truncatedAt: Date | null = null) => ({ candidates, truncatedAt });

beforeEach(() => {
  vi.clearAllMocks();
  m.isPushConfigured.mockReturnValue(true);
  m.listPushEnabledOrganizationIds.mockResolvedValue(["o"]);
  m.listCurrentMemberIds.mockImplementation(async (_d: unknown, _o: string, ids: string[]) => new Set(ids));
  m.claimPushDedupe.mockResolvedValue(true);
  m.sendPushToUser.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
  m.listNewAssignmentCandidates.mockResolvedValue(list([]));
  m.listCustomerMessageCandidates.mockResolvedValue(list([]));
  m.listSlaRiskCandidates.mockResolvedValue([]);
});

describe("runPushSweep", () => {
  it("o cursor começa 2 minutos antes de subir e avança depois de uma varredura bem-sucedida", async () => {
    const cursor = createPushCursor(now);
    expect(cursor.assignmentsSince).toEqual(new Date("2026-10-17T11:58:00Z"));
    const at = new Date("2026-10-17T12:00:30Z");
    await runPushSweep(db, cursor, at);
    expect(m.listNewAssignmentCandidates).toHaveBeenCalledWith(db, new Date("2026-10-17T11:58:00Z"), ["o"]);
    expect(cursor.assignmentsSince).toEqual(new Date("2026-10-17T12:00:20Z"));
    expect(cursor.messagesSince).toEqual(new Date("2026-10-17T12:00:20Z"));
  });

  it("falha de uma fonte não avança o cursor dela (nem das outras fontes funciona sem ela) e os demais gatilhos seguem", async () => {
    m.listNewAssignmentCandidates.mockRejectedValue(new Error("boom"));
    m.listSlaRiskCandidates.mockResolvedValue([cand({ kind: "sla", dedupeKeys: ["sla:a1"] })]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cursor = createPushCursor(now);
    const before = cursor.assignmentsSince;
    const r = await runPushSweep(db, cursor, new Date("2026-10-17T12:00:30Z"));
    expect(cursor.assignmentsSince).toEqual(before);
    expect(cursor.messagesSince).toEqual(new Date("2026-10-17T12:00:20Z"));
    expect(r.sent).toBe(1);
    log.mockRestore();
  });

  it("limite atingido: o cursor só avança até a última linha lida", async () => {
    const cut = new Date("2026-10-17T12:00:05Z");
    m.listCustomerMessageCandidates.mockResolvedValue(list([], cut));
    const cursor = createPushCursor(now);
    await runPushSweep(db, cursor, new Date("2026-10-17T12:00:30Z"));
    expect(cursor.messagesSince).toEqual(cut);
  });

  it("sem organizações com a flag ligada: retorna cedo, sem consultar eventos", async () => {
    m.listPushEnabledOrganizationIds.mockResolvedValue([]);
    const cursor = createPushCursor(now);
    const r = await runPushSweep(db, cursor, now);
    expect(m.listNewAssignmentCandidates).not.toHaveBeenCalled();
    expect(m.listCustomerMessageCandidates).not.toHaveBeenCalled();
    expect(m.listSlaRiskCandidates).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
  });

  it("sem chaves VAPID a varredura nem consulta o banco", async () => {
    m.isPushConfigured.mockReturnValue(false);
    const r = await runPushSweep(db, createPushCursor(now), now);
    expect(m.listPushEnabledOrganizationIds).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: 0, skipped: true });
  });

  it("envia o lead novo ao vendedor, filtrando as assinaturas pela organização", async () => {
    m.listNewAssignmentCandidates.mockResolvedValue(list([cand()]));
    const r = await runPushSweep(db, createPushCursor(now), now);
    expect(m.claimPushDedupe).toHaveBeenCalledWith(db, "assign:a1", "u1");
    expect(m.sendPushToUser).toHaveBeenCalledWith(db, "u1", { title: "Novo lead: Ana", body: "b", url: "/inbox?id=c", tag: "c" }, { organizationId: "o" });
    expect(r.sent).toBe(1);
  });

  it("dedupe: chave já registrada não reenvia", async () => {
    m.listNewAssignmentCandidates.mockResolvedValue(list([cand()]));
    m.claimPushDedupe.mockResolvedValue(false);
    await runPushSweep(db, createPushCursor(now), now);
    expect(m.sendPushToUser).not.toHaveBeenCalled();
  });

  it("quem não é mais membro não recebe e perde as assinaturas da organização", async () => {
    m.listNewAssignmentCandidates.mockResolvedValue(list([cand({ userId: "ex" }), cand({ userId: "u2", dedupeKeys: ["assign:a2"] })]));
    m.listCurrentMemberIds.mockResolvedValue(new Set(["u2"]));
    await runPushSweep(db, createPushCursor(now), now);
    expect(m.deletePushSubscriptionsForUser).toHaveBeenCalledWith(db, "o", "ex");
    expect(m.sendPushToUser.mock.calls.map(c => c[1])).toEqual(["u2"]);
    expect(m.claimPushDedupe).not.toHaveBeenCalledWith(db, "assign:a1", "ex");
  });

  it("cada destinatário recebe só o próprio envio, mesmo com candidatos de vários vendedores", async () => {
    m.listCustomerMessageCandidates.mockResolvedValue(list([
      cand({ kind: "message", userId: "u2", dedupeKeys: ["msg:m1"], title: "para u2" }),
      cand({ kind: "message", userId: "u3", dedupeKeys: ["msg:m2"], title: "para u3" }),
    ]));
    await runPushSweep(db, createPushCursor(now), now);
    const sent = m.sendPushToUser.mock.calls.map(c => [c[1], c[2].title]);
    expect(sent).toEqual([["u2", "para u2"], ["u3", "para u3"]]);
  });

  it("várias mensagens da conversa viram um envio, mesmo com algumas chaves já registradas", async () => {
    m.listCustomerMessageCandidates.mockResolvedValue(list([cand({ kind: "message", dedupeKeys: ["msg:m1", "msg:m2"] })]));
    m.claimPushDedupe.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await runPushSweep(db, createPushCursor(now), now);
    expect(m.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it("lead novo e SLA do mesmo lead na mesma varredura: ambos chegam com a mesma tag (o segundo substitui o primeiro)", async () => {
    m.listNewAssignmentCandidates.mockResolvedValue(list([cand()]));
    m.listSlaRiskCandidates.mockResolvedValue([cand({ kind: "sla", dedupeKeys: ["sla:a1"], title: "Responda Ana" })]);
    await runPushSweep(db, createPushCursor(now), now);
    expect(m.listSlaRiskCandidates).toHaveBeenCalledWith(db, now, ["o"], 15);
    expect(m.sendPushToUser.mock.calls.map(c => c[2].tag)).toEqual(["c", "c"]);
  });

  it("tempestade: acima do teto por vendedor vira um único push de resumo, sem perder eventos", async () => {
    const many = Array.from({ length: 8 }, (_, i) => cand({ dedupeKeys: [`assign:a${i}`], tag: `c${i}` }));
    m.listNewAssignmentCandidates.mockResolvedValue(list(many));
    await runPushSweep(db, createPushCursor(now), now);
    expect(m.claimPushDedupe).toHaveBeenCalledTimes(8);
    expect(m.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(m.sendPushToUser.mock.calls[0][2]).toMatchObject({ title: "8 novos leads", url: "/inbox", tag: "push-summary" });
  });

  it("falha no envio libera as chaves para nova tentativa", async () => {
    m.listNewAssignmentCandidates.mockResolvedValue(list([cand()]));
    m.sendPushToUser.mockRejectedValue(new Error("db"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await runPushSweep(db, createPushCursor(now), now);
    expect(m.releasePushDedupe).toHaveBeenCalledWith(db, ["assign:a1"]);
    log.mockRestore();
  });

  it("apaga o log com mais de 7 dias no máximo uma vez por hora", async () => {
    const cursor = createPushCursor(now);
    await runPushSweep(db, cursor, now);
    await runPushSweep(db, cursor, new Date(now.getTime() + 30_000));
    expect(m.purgePushNotificationLog).toHaveBeenCalledTimes(1);
    expect(m.purgePushNotificationLog).toHaveBeenCalledWith(db, new Date("2026-10-10T12:00:00Z"));
    await runPushSweep(db, cursor, new Date(now.getTime() + 61 * 60_000));
    expect(m.purgePushNotificationLog).toHaveBeenCalledTimes(2);
  });
});
