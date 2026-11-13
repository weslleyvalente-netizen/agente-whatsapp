import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdTouchView } from "@aula-agente/shared";
import { AdOriginList, type AdOriginListProps } from "./ad-origin-list";

const t = (over: Partial<AdTouchView> = {}): AdTouchView => ({
  id: "t1", touched_at: "2026-11-13T15:00:00Z", platform: "instagram", source_type: "ad", ad_id: "999", ad_title: "Seu próximo carro",
  ad_body: "Consórcio ou carta contemplada", ad_url: "https://www.instagram.com/p/AAA/", campaign_id: null, campaign_name: null, conversation_id: null, ...over,
});
const html = (touches: AdTouchView[], extra: Partial<AdOriginListProps> = {}) => renderToStaticMarkup(<AdOriginList touches={touches} {...extra} />);

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

  it("o 'primeiro anúncio' vem do id informado, não da posição na lista", () => {
    const out = html([t({ id: "b", ad_title: "Segundo" }), t({ id: "a", ad_title: "Primeiro" })], { firstTouchId: "a" });
    expect(out).toContain("primeiro anúncio");
    expect(out.match(/primeiro anúncio/g)).toHaveLength(1);
    // lista truncada: o último da lista NÃO é o primeiro anúncio do contato
    const truncated = html([t({ id: "x", ad_title: "Mais novo" }), t({ id: "y", ad_title: "Mais velho da lista" })], { firstTouchId: "z-fora-da-lista", totalTouches: 80 });
    expect(truncated).not.toContain("primeiro anúncio");
    expect(truncated).toContain("Mostrando 2 de 80 anúncios");
  });

  it("marca o anúncio que originou o negócio, indicando a base (conversa ou horário)", () => {
    const touches = [t({ id: "b", ad_title: "Segundo" }), t({ id: "a", ad_title: "Primeiro" })];
    expect(html(touches, { attributedId: "a", attribution: "conversation" })).toContain("originou este negócio (ligado à conversa)");
    const estimated = html(touches, { attributedId: "a", attribution: "estimated" });
    expect(estimated).toContain("origem estimada pelo horário (não comprovada)");
    expect(estimated).not.toContain("originou este negócio");
  });

  it("origem indeterminada: avisa que nenhum anúncio está ligado ao negócio, sem marcar nenhum", () => {
    const out = html([t()], { attributedId: null, attribution: "indeterminate" });
    expect(out).toContain("Origem do anúncio indeterminada");
    expect(out).not.toContain("originou este negócio");
    expect(out).toContain("Seu próximo carro");
  });

  it("fora de oportunidade (sem atribuição) não mostra aviso de indeterminada", () => {
    expect(html([t()], { attributedId: null, attribution: null })).not.toContain("indeterminada");
  });

  it("um toque só não diz 'primeiro anúncio' e só mostra campanha quando existir", () => {
    expect(html([t()], { firstTouchId: "t1" })).not.toContain("primeiro anúncio");
    expect(html([t()])).not.toContain("Campanha");
    expect(html([t({ campaign_name: "Black Novembro" })])).toContain("Campanha: Black Novembro");
  });
});
