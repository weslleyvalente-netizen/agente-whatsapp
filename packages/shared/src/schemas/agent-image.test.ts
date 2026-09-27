import { describe, it, expect } from "vitest";
import { agentKnowledgeConfigSchema, agentImageItemSchema } from "./agent-config.js";
import { toolsConfigSchema } from "./agent.js";

const image = {
  id: "3f0c2c1e-8a47-4a55-9d3c-2f4f7c2b9a10",
  titulo: "Catálogo Libera Cred",
  quando_enviar: "cliente pede o catálogo, todas as motos ou as opções do Libera Cred",
  legenda: "Motos do plano Libera Cred — preços de referência do plano (tabela 23/09/2026).",
  url: "https://example.supabase.co/storage/v1/object/public/agent-media/org/agent/x.png",
  storage_path: "org/agent/x.png",
  ativo: true,
};

describe("agentImageItemSchema", () => {
  it("accepts a valid image item", () => {
    expect(agentImageItemSchema.safeParse(image).success).toBe(true);
  });

  it("rejects fields over their limits", () => {
    expect(agentImageItemSchema.safeParse({ ...image, titulo: "x".repeat(151) }).success).toBe(false);
    expect(agentImageItemSchema.safeParse({ ...image, quando_enviar: "x".repeat(501) }).success).toBe(false);
    expect(agentImageItemSchema.safeParse({ ...image, legenda: "x".repeat(1001) }).success).toBe(false);
  });

  it("rejects a non-URL url", () => {
    expect(agentImageItemSchema.safeParse({ ...image, url: "catalogo.png" }).success).toBe(false);
  });
});

describe("agentKnowledgeConfigSchema.imagens", () => {
  it("defaults to an empty list for configs saved before this feature", () => {
    const parsed = agentKnowledgeConfigSchema.parse({ precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true });
    expect(parsed.imagens).toEqual([]);
  });

  it("caps the list at 20 images", () => {
    const imagens = Array.from({ length: 21 }, (_, i) => ({ ...image, id: `id-${i}` }));
    expect(agentKnowledgeConfigSchema.safeParse({ imagens }).success).toBe(false);
  });
});

describe("toolsConfigSchema.send_registered_image", () => {
  it("defaults to false", () => {
    expect(toolsConfigSchema.parse({}).send_registered_image).toBe(false);
  });
});
