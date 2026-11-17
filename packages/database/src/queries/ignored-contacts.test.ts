import { describe, expect, it } from "vitest";
import { getIgnoredContact } from "./ignored-contacts.js";

// Cliente falso mínimo: registra o filtro .in("phone", ...) e devolve as linhas "do banco" que casam exatamente com um dos candidatos.
function fakeClient(rows: Array<{ organization_id: string; phone: string; retention_mode: string; label?: string }>) {
  const seen: { orgs: string[]; inPhones: string[][] } = { orgs: [], inPhones: [] };
  const q: any = { _org: "", _phones: null as string[] | null };
  q.select = () => q; q.eq = (_c: string, v: string) => { q._org = v; seen.orgs.push(v); return q; };
  q.in = (_c: string, v: string[]) => { q._phones = v; seen.inPhones.push(v); return q; };
  q.then = (res: (v: unknown) => unknown) => res({ data: rows.filter((r) => r.organization_id === q._org && (q._phones ?? []).includes(r.phone)), error: null });
  return { client: { from: () => q } as never, seen };
}
const row = (phone: string, mode = "no_store", org = "org") => ({ organization_id: org, phone, retention_mode: mode, label: phone });

describe("getIgnoredContact com o 9º dígito", () => {
  it("lista com o 9 e mensagem chegando sem o 9 (o caso de 17/11): é ignorado", async () => {
    const { client } = fakeClient([row("5562996188374")]);
    expect((await getIgnoredContact(client, "org", "556296188374"))?.phone).toBe("5562996188374");
  });
  it("lista sem o 9 e mensagem com o 9: é ignorado", async () => {
    const { client } = fakeClient([row("556296188374")]);
    expect((await getIgnoredContact(client, "org", "5562996188374"))?.phone).toBe("556296188374");
  });
  it("número DIFERENTE não casa (final, DDD ou fixo)", async () => {
    const { client } = fakeClient([row("5562996188374"), row("556233124567")]);
    for (const p of ["5562996188375", "5561996188374", "5511996188374", "5562933124567"]) expect(await getIgnoredContact(client, "org", p)).toBeNull();
  });
  it("não vaza entre organizações", async () => {
    const { client } = fakeClient([row("5562996188374", "no_store", "outra")]);
    expect(await getIgnoredContact(client, "org", "556296188374")).toBeNull();
  });
  it("as duas formas cadastradas: vale no_store e depois o casamento exato", async () => {
    const a = fakeClient([row("556296188374", "minimal_record"), row("5562996188374", "no_store")]);
    expect((await getIgnoredContact(a.client, "org", "556296188374"))?.retention_mode).toBe("no_store");
    const b = fakeClient([row("556296188374", "minimal_record"), row("5562996188374", "minimal_record")]);
    expect((await getIgnoredContact(b.client, "org", "556296188374"))?.phone).toBe("556296188374");
  });
  it("consulta única indexada (um .in com as formas) e telefone vazio não consulta", async () => {
    const { client, seen } = fakeClient([]);
    await getIgnoredContact(client, "org", "5562996188374"); expect(seen.inPhones).toHaveLength(1);
    expect(seen.inPhones[0]).toEqual(expect.arrayContaining(["5562996188374", "556296188374"]));
    expect(await getIgnoredContact(client, "org", "")).toBeNull(); expect(seen.inPhones).toHaveLength(1);
  });
  it("só lê: não escreve nada nem mescla contatos (cliente falso não tem insert/update/delete)", async () => {
    const { client } = fakeClient([row("5562996188374")]); const c = client as unknown as { from: () => Record<string, unknown> };
    const t = c.from(); expect(t.insert).toBeUndefined(); expect(t.update).toBeUndefined(); expect(t.delete).toBeUndefined();
  });
});
