import { describe, it, expect } from "vitest";
import { compileSystemPrompt } from "./prompt-builder.js";
import type { AgentConfigSections } from "./types/agent-config.js";

function baseConfig(overrides: Partial<AgentConfigSections> = {}): AgentConfigSections {
  return {
    identity: { nome: "", funcao: "", missao: "" },
    personality: {
      tom_de_voz: "equilibrado",
      tom_de_voz_personalizado: "",
      tamanho_resposta: "curta",
      emojis: { ativo: true, maximo: 1, instrucao: "" },
      perguntas_por_vez: { maximo: 1 },
      postura_comercial: { tipo: "", instrucao: "" },
      girias_proibidas: [],
      proatividade: "",
    },
    rules: {
      transferencia_para_humano: [],
      promessas_proibidas: [],
      regras_por_tipo: [],
      preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" },
      objecoes: [],
    },
    knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
    playbook: { script_atendimento: "" },
    ...overrides,
  };
}

describe("compileSystemPrompt", () => {
  it("compiles identity name, function, and mission", () => {
    const result = compileSystemPrompt(
      baseConfig({ identity: { nome: "Helena", funcao: "Consultora virtual", missao: "Ajudar o cliente a decidir." } })
    );
    expect(result).toContain("Nome: Helena");
    expect(result).toContain("Função: Consultora virtual");
    expect(result).toContain("Ajudar o cliente a decidir.");
  });

  it("uses the custom tone text when tom_de_voz is personalizado", () => {
    const result = compileSystemPrompt(
      baseConfig({
        personality: {
          ...baseConfig().personality,
          tom_de_voz: "personalizado",
          tom_de_voz_personalizado: "Direto e bem-humorado",
        },
      })
    );
    expect(result).toContain("Tom de voz: Direto e bem-humorado");
  });

  it("describes the emoji limit when emojis are active, and says not to use them otherwise", () => {
    const withEmojis = compileSystemPrompt(
      baseConfig({ personality: { ...baseConfig().personality, emojis: { ativo: true, maximo: 1, instrucao: "só quando fizer sentido" } } })
    );
    expect(withEmojis).toContain("no máximo 1 por mensagem. só quando fizer sentido");

    const noEmojis = compileSystemPrompt(
      baseConfig({ personality: { ...baseConfig().personality, emojis: { ativo: false, maximo: 0, instrucao: "" } } })
    );
    expect(noEmojis).toContain("Emojis: não usar.");
  });

  it("only lists active handoff triggers, promises, and category rules — inactive ones are dropped", () => {
    const result = compileSystemPrompt(
      baseConfig({
        rules: {
          transferencia_para_humano: [
            { id: "a", label: "Reclamação", instrucao: "Transferir sempre", ativo: true },
            { id: "b", label: "Desconto", instrucao: "Nunca ativo", ativo: false },
          ],
          promessas_proibidas: [{ id: "c", label: "Prazo", instrucao: "Nunca prometer prazo", ativo: true }],
          regras_por_tipo: [{ id: "d", categoria: "Consórcio", instrucao: "Explicar contemplação", ativo: true }],
          preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" },
          objecoes: [],
        },
      })
    );
    expect(result).toContain("Reclamação: Transferir sempre");
    expect(result).not.toContain("Nunca ativo");
    expect(result).toContain("Nunca prometer prazo");
    expect(result).toContain("### Consórcio");
    expect(result).toContain("Explicar contemplação");
  });

  it("compiles preço e desconto only when at least one of its fields is filled", () => {
    const empty = compileSystemPrompt(baseConfig());
    expect(empty).not.toContain("Preço e desconto");

    const filled = compileSystemPrompt(
      baseConfig({
        rules: {
          ...baseConfig().rules,
          preco_desconto: { pode_autonomo: "Preço de tabela", exige_humano: "Desconto", nunca_pode: "", observacoes: "" },
        },
      })
    );
    expect(filled).toContain("Pode informar sozinho: Preço de tabela");
    expect(filled).toContain("Exige humano: Desconto");
  });

  it("only includes active objections, with all 4 fields", () => {
    const result = compileSystemPrompt(
      baseConfig({
        rules: {
          ...baseConfig().rules,
          objecoes: [
            {
              id: "preco-alto", nome: "Preço alto", ativo: true,
              como_identificar: "Cliente diz que está caro",
              orientacao: "Descobrir se é valor total, entrada ou parcela",
              pergunta_diagnostico: "É o valor total, a entrada ou a parcela que pesa mais?",
              quando_escalar: "Se pedir desconto explícito",
            },
            { id: "x", nome: "Inativa", ativo: false, como_identificar: "", orientacao: "", pergunta_diagnostico: "", quando_escalar: "" },
          ],
        },
      })
    );
    expect(result).toContain("### Preço alto");
    expect(result).toContain("Cliente diz que está caro");
    expect(result).toContain("valor total, a entrada ou a parcela");
    expect(result).not.toContain("Inativa");
  });

  it("inlines active price notes and links but skips inactive links", () => {
    const result = compileSystemPrompt(
      baseConfig({
        knowledge: {
          precos_notas: "Consulte a tabela de referência antes de informar valores.",
          links: [
            { id: "a", titulo: "Catálogo", url: "https://example.com/catalogo", ativo: true },
            { id: "b", titulo: "Antigo", url: "https://example.com/antigo", ativo: false },
          ],
          documentos_ativos: true,
          faqs_ativas: true,
        },
      })
    );
    expect(result).toContain("Consulte a tabela de referência");
    expect(result).toContain("Catálogo: https://example.com/catalogo");
    expect(result).not.toContain("Antigo");
  });

  it("includes the playbook script when present, omits the section when empty", () => {
    const withScript = compileSystemPrompt(baseConfig({ playbook: { script_atendimento: "1. Identificar necessidade" } }));
    expect(withScript).toContain("Script de atendimento");
    expect(withScript).toContain("1. Identificar necessidade");

    const withoutScript = compileSystemPrompt(baseConfig());
    expect(withoutScript).not.toContain("Script de atendimento");
  });

  it("never leaves stray blank section headers for fully-empty sections", () => {
    const result = compileSystemPrompt(baseConfig());
    // With every field empty, only Personalidade (which always renders tone/
    // response-size/questions-per-message) should appear.
    expect(result).not.toContain("# Identidade");
    expect(result).not.toContain("# Regras");
    expect(result).not.toContain("# Preços");
    expect(result).not.toContain("# Playbook");
    expect(result).toContain("# Personalidade");
  });
});
