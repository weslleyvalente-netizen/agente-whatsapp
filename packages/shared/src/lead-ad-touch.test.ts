import { describe, expect, it } from "vitest";
import { extractAdTouch, attributeTouch, shouldRecordTouch, ATTRIBUTION_WINDOW_MS, TOUCH_SESSION_GAP_MS } from "./lead-ad-touch.js";

const full = {
  title: "Seu próximo carro", body: "Consórcio ou carta contemplada", sourceType: "ad", sourceId: "120248978818540570",
  sourceUrl: "https://www.instagram.com/p/DflFcO8sLTg/?utm_source=x", ctwaClid: "ARAk-abc", sourceApp: "instagram", mediaType: 1,
  thumbnail: "BINARIO", thumbnailUrl: "https://cdn/x.jpg", renderLargerThumbnail: true, showAdAttribution: false,
};

describe("extractAdTouch", () => {
  it("anúncio completo: plataforma, id, título, texto, link, tipo, clid; campanha fica nula (o WhatsApp não envia)", () => {
    expect(extractAdTouch(full)).toMatchObject({
      platform: "instagram", source_type: "ad", ad_id: "120248978818540570", ad_title: "Seu próximo carro", ad_body: "Consórcio ou carta contemplada",
      ad_url: "https://www.instagram.com/p/DflFcO8sLTg/?utm_source=x", ctwa_clid: "ARAk-abc", campaign_id: null, campaign_name: null,
    });
  });

  it("lista só os NOMES dos campos presentes (sem valores), ignorando binários e campos vazios/falsos", () => {
    const t = extractAdTouch({ ...full, body: "", ctwaClid: null, renderLargerThumbnail: false })!;
    expect(t.available_fields).toEqual(["mediaType", "sourceApp", "sourceId", "sourceType", "sourceUrl", "thumbnailUrl", "title"]);
    expect(t.available_fields).not.toContain("thumbnail");
    expect(JSON.stringify(t.available_fields)).not.toContain("BINARIO");
  });

  it("campos ausentes viram null, sem lançar", () => {
    expect(extractAdTouch({ title: "Só o título" })).toMatchObject({ platform: "meta", ad_id: null, ad_url: null, ctwa_clid: null, ad_body: null, source_type: null, ad_title: "Só o título" });
  });

  it("sem contexto de anúncio ou sem nada que identifique o anúncio devolve null", () => {
    expect(extractAdTouch(null)).toBeNull();
    expect(extractAdTouch(undefined)).toBeNull();
    expect(extractAdTouch({})).toBeNull();
    expect(extractAdTouch({ title: "  ", body: "", sourceId: null, sourceUrl: "", mediaType: 1, showAdAttribution: true })).toBeNull();
  });

  it("plataforma: instagram por host ou sourceApp, facebook por host/sourceApp, senão meta; host forjado não conta", () => {
    expect(extractAdTouch({ sourceUrl: "https://instagram.com/p/x", title: "a" })!.platform).toBe("instagram");
    expect(extractAdTouch({ sourceApp: "facebook", title: "a" })!.platform).toBe("facebook");
    expect(extractAdTouch({ sourceUrl: "https://fb.me/abc", title: "a" })!.platform).toBe("meta");
    expect(extractAdTouch({ sourceUrl: "https://evil.com/instagram.com/p", title: "a" })!.platform).toBe("meta");
  });

  it("limita tamanhos e aceita id numérico", () => {
    const t = extractAdTouch({ title: "t".repeat(500), body: "b".repeat(2000), sourceUrl: "https://instagram.com/" + "u".repeat(2000), sourceId: 12345, ctwaClid: "c".repeat(900) })!;
    expect(t.ad_title!.length).toBe(300);
    expect(t.ad_body!.length).toBe(1000);
    expect(t.ad_url!.length).toBe(1000);
    expect(t.ad_id).toBe("12345");
    expect(t.ctwa_clid!.length).toBe(500);
  });

  it("chave do toque: id do anúncio > link sem parâmetros > título e texto normalizados", () => {
    expect(extractAdTouch({ sourceId: "99", sourceUrl: "https://x/y", title: "a" })!.touch_key).toBe("id:99");
    expect(extractAdTouch({ sourceUrl: "https://www.instagram.com/p/AAA/?utm=1#f", title: "a" })!.touch_key).toBe("url:https://www.instagram.com/p/AAA/");
    expect(extractAdTouch({ title: " Seu  Próximo Carro ", body: "Texto" })!.touch_key).toBe("txt:seu próximo carro|texto");
  });

  it("o mesmo anúncio com ctwaClid diferente mantém a mesma chave", () => {
    const a = extractAdTouch({ ...full, ctwaClid: "A" })!;
    const b = extractAdTouch({ ...full, ctwaClid: "B" })!;
    expect(a.touch_key).toBe(b.touch_key);
  });
});

describe("shouldRecordTouch (deduplicação)", () => {
  const at = (iso: string) => new Date(iso);
  const prev = (key: string, clid: string | null, iso: string) => ({ touch_key: key, ctwa_clid: clid, touched_at: iso });
  const cand = (key: string, clid: string | null, iso: string) => ({ touch_key: key, ctwa_clid: clid, touchedAt: at(iso) });

  it("primeiro toque do contato é gravado", () => {
    expect(shouldRecordTouch(cand("id:1", "A", "2026-11-13T10:00:00Z"), [])).toBe(true);
  });
  it("anúncio diferente do histórico recente é um novo toque", () => {
    expect(shouldRecordTouch(cand("id:2", "B", "2026-11-13T10:00:00Z"), [prev("id:1", "A", "2026-11-13T09:00:00Z")])).toBe(true);
  });
  it("MESMO anúncio com outro clique comprovado (ctwa_clid diferente) em atendimento posterior é novo toque", () => {
    expect(shouldRecordTouch(cand("id:1", "B", "2026-11-13T10:00:00Z"), [prev("id:1", "A", "2026-11-13T09:50:00Z")])).toBe(true);
  });
  it("mesmo anúncio com o mesmo clique não duplica, mesmo que apareça de novo", () => {
    expect(shouldRecordTouch(cand("id:1", "A", "2026-12-30T10:00:00Z"), [prev("id:1", "A", "2026-11-13T09:50:00Z")])).toBe(false);
  });
  it("o clique já visto em qualquer toque recente do mesmo anúncio conta como duplicado", () => {
    const recent = [prev("id:1", "B", "2026-11-14T00:00:00Z"), prev("id:2", "X", "2026-11-13T12:00:00Z"), prev("id:1", "A", "2026-11-13T09:50:00Z")];
    expect(shouldRecordTouch(cand("id:1", "A", "2026-11-14T01:00:00Z"), recent)).toBe(false);
  });
  it("sem identificador de clique: dentro de 24 h é a mesma sessão (não duplica); a partir de 24 h é novo atendimento", () => {
    const recent = [prev("id:1", null, "2026-11-13T10:00:00Z")];
    expect(shouldRecordTouch(cand("id:1", null, "2026-11-14T09:59:00Z"), recent)).toBe(false);
    expect(shouldRecordTouch(cand("id:1", null, new Date(Date.parse("2026-11-13T10:00:00Z") + TOUCH_SESSION_GAP_MS).toISOString()), recent)).toBe(true);
  });
  it("clique de um lado e ausente do outro: não prova novo clique; vale a regra das 24 h", () => {
    expect(shouldRecordTouch(cand("id:1", "B", "2026-11-13T12:00:00Z"), [prev("id:1", null, "2026-11-13T10:00:00Z")])).toBe(false);
    expect(shouldRecordTouch(cand("id:1", null, "2026-11-20T12:00:00Z"), [prev("id:1", "A", "2026-11-13T10:00:00Z")])).toBe(true);
  });
  it("mensagem antiga reenviada (anterior ao último toque do mesmo anúncio) não cria toque", () => {
    expect(shouldRecordTouch(cand("id:1", null, "2026-11-10T10:00:00Z"), [prev("id:1", null, "2026-11-13T10:00:00Z")])).toBe(false);
  });
});

describe("attributeTouch (atribuição à oportunidade)", () => {
  const T = (id: string, at: string, conversation_id: string | null = null) => ({ id, touched_at: at, conversation_id });
  const created = "2026-11-13T12:00:00Z";
  const day = 24 * 60 * 60 * 1000;
  const before = (days: number) => new Date(Date.parse(created) - days * day).toISOString();

  it("prioriza o toque ligado à conversa do negócio, mesmo que haja um mais recente de outra conversa", () => {
    const touches = [T("recente", before(1), "outra"), T("da-conversa", before(3), "c1")];
    expect(attributeTouch(touches, { createdAt: created, conversationIds: ["c1"] })).toMatchObject({ basis: "conversation", touch: { id: "da-conversa" } });
  });
  it("toque da conversa vale mesmo fora da janela de tempo (a ligação com a conversa é a evidência)", () => {
    expect(attributeTouch([T("antigo", before(40), "c1")], { createdAt: created, conversationIds: ["c1"] })).toMatchObject({ basis: "conversation", touch: { id: "antigo" } });
  });
  it("sem ligação com a conversa: o mais recente dentro da janela de tempo (base 'time')", () => {
    const touches = [T("b", before(2)), T("a", before(10))];
    expect(attributeTouch(touches, { createdAt: created })).toMatchObject({ basis: "time", touch: { id: "b" } });
  });
  it("anúncio antigo sem relação comprovada NÃO é atribuído: origem indeterminada", () => {
    const old = [T("velho", new Date(Date.parse(created) - ATTRIBUTION_WINDOW_MS - day).toISOString())];
    expect(attributeTouch(old, { createdAt: created })).toEqual({ touch: null, basis: "indeterminate" });
    expect(attributeTouch(old, { createdAt: created, conversationIds: ["c1"] })).toEqual({ touch: null, basis: "indeterminate" });
  });
  it("toque depois da criação do negócio não conta; lista vazia ou datas inválidas: indeterminada", () => {
    expect(attributeTouch([T("depois", "2026-11-20T00:00:00Z", "c1")], { createdAt: created, conversationIds: ["c1"] })).toEqual({ touch: null, basis: "indeterminate" });
    expect(attributeTouch([], { createdAt: created })).toEqual({ touch: null, basis: "indeterminate" });
    expect(attributeTouch([T("x", "lixo")], { createdAt: created })).toEqual({ touch: null, basis: "indeterminate" });
    expect(attributeTouch([T("x", before(1))], { createdAt: "lixo" })).toEqual({ touch: null, basis: "indeterminate" });
  });
  it("tolera 1 minuto de diferença de relógio", () => {
    expect(attributeTouch([T("x", "2026-11-13T12:00:30Z")], { createdAt: created }).touch?.id).toBe("x");
    expect(attributeTouch([T("x", "2026-11-13T12:02:00Z")], { createdAt: created }).touch).toBeNull();
  });
});
