import { describe, expect, it } from "vitest";
import { extractAdTouch, pickAttributedTouch } from "./lead-ad-touch.js";

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

describe("pickAttributedTouch", () => {
  const T = (id: string, at: string) => ({ id, touched_at: at });
  const touches = [T("c", "2026-11-12T10:00:00Z"), T("b", "2026-11-10T10:00:00Z"), T("a", "2026-11-01T10:00:00Z")];
  it("escolhe o toque mais recente até a criação da oportunidade", () => {
    expect(pickAttributedTouch(touches, "2026-11-11T00:00:00Z")?.id).toBe("b");
    expect(pickAttributedTouch(touches, "2026-11-13T00:00:00Z")?.id).toBe("c");
  });
  it("tolera 1 minuto de diferença de relógio", () => {
    expect(pickAttributedTouch([T("x", "2026-11-10T10:00:30Z")], "2026-11-10T10:00:00Z")?.id).toBe("x");
    expect(pickAttributedTouch([T("x", "2026-11-10T10:02:00Z")], "2026-11-10T10:00:00Z")).toBeNull();
  });
  it("sem toque anterior ou lista vazia: null", () => {
    expect(pickAttributedTouch(touches, "2026-10-01T00:00:00Z")).toBeNull();
    expect(pickAttributedTouch([], "2026-11-10T00:00:00Z")).toBeNull();
  });
  it("datas inválidas não quebram", () => {
    expect(pickAttributedTouch([T("x", "lixo")], "2026-11-10T00:00:00Z")).toBeNull();
    expect(pickAttributedTouch(touches, "lixo")).toBeNull();
  });
});
