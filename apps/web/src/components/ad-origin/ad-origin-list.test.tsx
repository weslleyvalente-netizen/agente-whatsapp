import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdTouchView } from "@aula-agente/shared";
import { AdOriginList } from "./ad-origin-list";

const t = (over: Partial<AdTouchView> = {}): AdTouchView => ({
  id: "t1", touched_at: "2026-11-13T15:00:00Z", platform: "instagram", source_type: "ad", ad_id: "999", ad_title: "Seu próximo carro",
  ad_body: "Consórcio ou carta contemplada", ad_url: "https://www.instagram.com/p/AAA/", campaign_id: null, campaign_name: null, conversation_id: null, ...over,
});
const html = (touches: AdTouchView[], attributedId?: string | null) => renderToStaticMarkup(<AdOriginList touches={touches} attributedId={attributedId} />);

describe("AdOriginList", () => {
  it("mostra título, plataforma, data, texto, id e o link do anúncio", () => {
    const out = html([t()]);
    expect(out).toContain("Seu próximo carro");
    expect(out).toContain("Instagram");
    expect(out).toContain("13/11/2026 12:00");
    expect(out).toContain("Consórcio ou carta contemplada");
    expect(out).toContain("999");
    expect(out).toContain('href="https://www.instagram.com/p/AAA/"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("não renderiza nada sem toques", () => expect(html([])).toBe(""));

  it("campos ausentes são omitidos sem quebrar", () => {
    const out = html([t({ ad_title: null, ad_body: null, ad_id: null, ad_url: null })]);
    expect(out).toContain("Anúncio do Instagram");
    expect(out).not.toContain("ID do anúncio");
    expect(out).not.toContain("Abrir anúncio");
  });

  it("link que não é http(s) nunca vira link", () => {
    expect(html([t({ ad_url: "javascript:alert(1)" })])).not.toContain("href=");
  });

  it("com vários toques marca o primeiro anúncio e o que originou o negócio", () => {
    const out = html([t({ id: "b", ad_title: "Segundo" }), t({ id: "a", ad_title: "Primeiro" })], "a");
    expect(out).toContain("primeiro anúncio");
    expect(out).toContain("originou este negócio");
    expect(out.indexOf("Segundo")).toBeLessThan(out.indexOf("Primeiro"));
  });

  it("um toque só não diz 'primeiro anúncio' e só mostra campanha quando existir", () => {
    expect(html([t()])).not.toContain("primeiro anúncio");
    expect(html([t()])).not.toContain("Campanha");
    expect(html([t({ campaign_name: "Black Novembro" })])).toContain("Campanha: Black Novembro");
  });
});
