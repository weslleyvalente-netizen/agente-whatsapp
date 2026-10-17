import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  getOrganizationById: vi.fn(), claimPushDedupe: vi.fn(), sendPushToUser: vi.fn(), isPushConfigured: vi.fn(() => true),
  listNewAssignmentCandidates: vi.fn(), listCustomerMessageCandidates: vi.fn(), listSlaRiskCandidates: vi.fn(),
}));
vi.mock("@aula-agente/database", () => m);
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getPushNotificationsQueue: () => ({ upsertJobScheduler: vi.fn() }) }));
import { runPushSweep, createPushCursor } from "./push-notifications.js";

const now = new Date("2026-10-17T12:00:00Z");
const cand = (over: Record<string, unknown> = {}) => ({ organizationId: "o", userId: "u1", dedupeKeys: ["assign:a1"], title: "Novo lead: Ana", body: "b", url: "/inbox?id=c", tag: "t", ...over });
const db = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.isPushConfigured.mockReturnValue(true);
  m.getOrganizationById.mockResolvedValue({ settings: { push_notifications_enabled: true } });
  m.claimPushDedupe.mockResolvedValue(true);
  m.sendPushToUser.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
  m.listNewAssignmentCandidates.mockResolvedValue([]);
  m.listCustomerMessageCandidates.mockResolvedValue([]);
  m.listSlaRiskCandidates.mockResolvedValue([]);
});

describe("runPushSweep", () => {
  it("o cursor começa 2 minutos antes de subir e avança depois da varredura", async () => {
    const cursor = createPushCursor(now);
    expect(cursor.since).toEqual(new Date("2026-10-17T11:58:00Z"));
    await runPushSweep(db, cursor, new Date("2026-10-17T12:00:30Z"));
    expect(m.listNewAssignmentCandidates).toHaveBeenCalledWith(db, new Date("2026-10-17T11:58:00Z"));
    expect(cursor.since.getTime()).toBeGreaterThan(new Date("2026-10-17T11:59:00Z").getTime());
  });

  it("envia o lead novo ao vendedor dono e registra a chave", async () => {
    m.listNewAssignmentCandidates.mockResolvedValue([cand()]);
    const r = await runPushSweep(db, createPushCursor(now), now);
    expect(m.claimPushDedupe).toHaveBeenCalledWith(db, "assign:a1", "u1");
    expect(m.sendPushToUser).toHaveBeenCalledWith(db, "u1", { title: "Novo lead: Ana", body: "b", url: "/inbox?id=c", tag: "t" });
    expect(r.sent).toBe(1);
  });

  it("dedupe: chave já registrada não reenvia", async () => {
    m.listNewAssignmentCandidates.mockResolvedValue([cand()]);
    m.claimPushDedupe.mockResolvedValue(false);
    const r = await runPushSweep(db, createPushCursor(now), now);
    expect(m.sendPushToUser).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
  });

  it("flag desligada (ausente ou false) não consulta dedupe nem envia", async () => {
    m.listNewAssignmentCandidates.mockResolvedValue([cand()]);
    m.getOrganizationById.mockResolvedValue({ settings: {} });
    await runPushSweep(db, createPushCursor(now), now);
    expect(m.claimPushDedupe).not.toHaveBeenCalled();
    expect(m.sendPushToUser).not.toHaveBeenCalled();
  });

  it("sem chaves VAPID a varredura nem consulta o banco", async () => {
    m.isPushConfigured.mockReturnValue(false);
    const r = await runPushSweep(db, createPushCursor(now), now);
    expect(m.listNewAssignmentCandidates).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: 0, skipped: true });
  });

  it("cada vendedor recebe só o que é dele: o destinatário vem sempre do candidato", async () => {
    m.listCustomerMessageCandidates.mockResolvedValue([cand({ userId: "u2", dedupeKeys: ["msg:m1"], tag: "c" }), cand({ userId: "u3", dedupeKeys: ["msg:m2"], tag: "d" })]);
    await runPushSweep(db, createPushCursor(now), now);
    expect(m.sendPushToUser.mock.calls.map(c => c[1])).toEqual(["u2", "u3"]);
  });

  it("várias mensagens da conversa viram um envio, mesmo com algumas chaves já registradas", async () => {
    m.listCustomerMessageCandidates.mockResolvedValue([cand({ dedupeKeys: ["msg:m1", "msg:m2"] })]);
    m.claimPushDedupe.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await runPushSweep(db, createPushCursor(now), now);
    expect(m.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it("gatilho SLA usa a janela de 15 min", async () => {
    m.listSlaRiskCandidates.mockResolvedValue([cand({ dedupeKeys: ["sla:a1"] })]);
    await runPushSweep(db, createPushCursor(now), now);
    expect(m.listSlaRiskCandidates).toHaveBeenCalledWith(db, now, 15);
    expect(m.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it("falha em um gatilho não impede os outros", async () => {
    m.listNewAssignmentCandidates.mockRejectedValue(new Error("boom"));
    m.listSlaRiskCandidates.mockResolvedValue([cand({ dedupeKeys: ["sla:a1"] })]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runPushSweep(db, createPushCursor(now), now);
    expect(r.sent).toBe(1);
    log.mockRestore();
  });
});
