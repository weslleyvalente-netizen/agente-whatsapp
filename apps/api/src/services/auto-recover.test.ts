import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getAllOrganizations: vi.fn(), getOrganizationById: vi.fn(), reconcile: vi.fn() }));
vi.mock("@aula-agente/database", () => ({ getAdminClient: () => ({}), getAllOrganizations: m.getAllOrganizations, getOrganizationById: m.getOrganizationById }));
vi.mock("../routes/admin/recover-messages.js", () => ({ reconcileRecentMessages: m.reconcile }));

import { runAutoRecoverOnce } from "./auto-recover.js";

const app = {} as never;
const log = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  m.reconcile.mockResolvedValue({ customers: 0, replayed: 0, saved: 0, failed: 0, failedInstances: [] });
});

describe("runAutoRecoverOnce", () => {
  it("só reconcilia organizações com a chave ligada (true)", async () => {
    m.getAllOrganizations.mockResolvedValue([
      { id: "a", settings: { auto_recover_messages_enabled: true } },
      { id: "b", settings: {} },
      { id: "c", settings: { auto_recover_messages_enabled: false } },
      { id: "d", settings: { auto_recover_messages_enabled: "true" } },
    ]);
    await runAutoRecoverOnce(app, log);
    expect(m.reconcile.mock.calls.map((c) => c[1])).toEqual(["a"]);
  });

  it("registra quando recupera mensagens e fica quieto quando não há nada", async () => {
    m.getAllOrganizations.mockResolvedValue([{ id: "a", settings: { auto_recover_messages_enabled: true } }]);
    await runAutoRecoverOnce(app, log);
    expect(log.info).not.toHaveBeenCalled();
    m.reconcile.mockResolvedValue({ customers: 2, replayed: 5, saved: 0, failed: 1, failedInstances: [] });
    await runAutoRecoverOnce(app, log);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "a", replayed: 5, failed: 1, customers: 2 }), expect.any(String));
  });

  it("registra falha do ciclo e instâncias com erro (só nomes, sem detalhes)", async () => {
    m.getAllOrganizations.mockResolvedValue([{ id: "a", settings: { auto_recover_messages_enabled: true } }]);
    m.reconcile.mockResolvedValue({ skipped: "error", customers: 0, replayed: 0, saved: 0, failed: 0, failedInstances: ["weslley"] });
    await runAutoRecoverOnce(app, log);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "a", skipped: "error", failedInstances: ["weslley"] }), expect.any(String));
  });

  it("registra ciclo truncado ou interrompido", async () => {
    m.getAllOrganizations.mockResolvedValue([{ id: "a", settings: { auto_recover_messages_enabled: true } }]);
    m.reconcile.mockResolvedValue({ customers: 50, replayed: 50, saved: 0, failed: 0, failedInstances: [], truncated: true });
    await runAutoRecoverOnce(app, log);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ truncated: true }), expect.any(String));
  });

  it("a função stillEnabled relê a chave da organização", async () => {
    m.getAllOrganizations.mockResolvedValue([{ id: "a", settings: { auto_recover_messages_enabled: true } }]);
    let check!: () => Promise<boolean>;
    m.reconcile.mockImplementation(async (_a: unknown, _o: string, opts: { stillEnabled: () => Promise<boolean> }) => { check = opts.stillEnabled; return { customers: 0, replayed: 0, saved: 0, failed: 0, failedInstances: [] }; });
    await runAutoRecoverOnce(app, log);
    m.getOrganizationById.mockResolvedValueOnce({ settings: { auto_recover_messages_enabled: true } });
    expect(await check()).toBe(true);
    m.getOrganizationById.mockResolvedValueOnce({ settings: { auto_recover_messages_enabled: false } });
    expect(await check()).toBe(false);
    m.getOrganizationById.mockRejectedValueOnce(new Error("db"));
    expect(await check()).toBe(false);
  });

  it("erro numa organização não impede as outras", async () => {
    m.getAllOrganizations.mockResolvedValue([
      { id: "a", settings: { auto_recover_messages_enabled: true } },
      { id: "b", settings: { auto_recover_messages_enabled: true } },
    ]);
    m.reconcile.mockRejectedValueOnce(new Error("boom apikey=zzz"));
    await runAutoRecoverOnce(app, log);
    expect(m.reconcile).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("zzz");
  });

  it("falha ao listar organizações não lança", async () => {
    m.getAllOrganizations.mockRejectedValue(new Error("db"));
    await expect(runAutoRecoverOnce(app, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});
