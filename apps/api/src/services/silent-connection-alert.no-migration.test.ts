import { beforeEach, describe, expect, it, vi } from "vitest";

// Comportamento do código REAL (defaultSilentDeps) quando a tabela silent_connection_alerts NÃO existe (migração ainda não aplicada),
// como o PostgREST responde: erro PGRST205 / 42P01 ao tocar a tabela. As demais tabelas respondem normalmente.
const touched: string[] = [];
const MISSING = { code: "PGRST205", message: "Could not find the table 'public.silent_connection_alerts' in the schema cache" };
let orgSettings: Record<string, unknown> = {};
const builder = (table: string) => {
  const b: any = new Proxy({}, { get: (_t, prop) => {
    if (prop === "then") return (res: (v: unknown) => void) => res(table === "silent_connection_alerts" ? { data: null, error: MISSING } : { data: null, error: null, count: 0 });
    if (prop === "maybeSingle") return async () => (table === "silent_connection_alerts" ? { data: null, error: MISSING } : table === "evolution_connection_observations"
      ? { data: { observed_at: new Date().toISOString(), evolution_state: "open", query_ok: true, last_evolution_message_at: new Date(Date.now() - 3 * 3600_000).toISOString() }, error: null } : { data: null, error: null });
    return (..._a: unknown[]) => b;
  } });
  touched.push(table); return b;
};
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({ from: builder }),
  getAllOrganizations: async () => [{ id: "org", settings: orgSettings }],
  getInstancesByOrganization: async () => [{ id: "inst", instance_name: "weslley" }],
  isPushConfigured: () => true, listManagerUserIds: async () => ["m1"], hasPushSubscription: async () => true, sendPushToUser: vi.fn(async () => ({ sent: 1 })),
}));
import { defaultSilentDeps, runSilentConnectionCycle } from "./silent-connection-alert.js";

const errors: string[] = []; const infos: string[] = [];
const log = { info: (_o: unknown, m?: string) => { infos.push(String(m)); }, error: (_o: unknown, m?: string) => { errors.push(String(m)); } } as never;
beforeEach(() => { touched.length = 0; errors.length = 0; infos.length = 0; delete process.env.SILENT_CONNECTION_HEARTBEAT_URL; });

describe("migração ausente (tabela inexistente)", () => {
  it("modo off: a tabela de alertas nunca é tocada e nada é registrado como erro", async () => {
    orgSettings = {}; const hb = vi.fn(); const deps = { ...defaultSilentDeps(log), heartbeat: hb };
    await runSilentConnectionCycle(deps, new Date());
    expect(touched).not.toContain("silent_connection_alerts"); expect(errors).toEqual([]); expect(hb).not.toHaveBeenCalled();
  });
  it.each(["shadow", "on"])("modo %s: não lança, não notifica, não emite heartbeat e registra erro por instância (nada quebra o processo)", async (mode) => {
    orgSettings = { silent_connection_alert_mode: mode }; const hb = vi.fn(async () => {}); const { sendPushToUser } = await import("@aula-agente/database");
    const deps = { ...defaultSilentDeps(log), heartbeat: hb };
    await expect(runSilentConnectionCycle(deps, new Date())).resolves.toBeUndefined();
    expect(errors.some((m) => m.includes("avaliação falhou"))).toBe(true); expect(hb).not.toHaveBeenCalled(); expect(sendPushToUser).not.toHaveBeenCalled();
  });
});
