import { describe, it, expect } from "vitest";
import { computeChangedSections } from "./agent-config-diff.js";
import type { AgentConfigSections } from "./types/agent-config.js";

function baseSections(): AgentConfigSections {
  return {
    identity: { nome: "Helena", funcao: "", missao: "" },
    personality: {
      tom_de_voz: "equilibrado", tom_de_voz_personalizado: "", tamanho_resposta: "curta",
      emojis: { ativo: true, maximo: 1, instrucao: "" }, perguntas_por_vez: { maximo: 1 },
      postura_comercial: { tipo: "", instrucao: "" }, girias_proibidas: [], proatividade: "",
    },
    rules: {
      transferencia_para_humano: [], promessas_proibidas: [], regras_por_tipo: [],
      preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" }, objecoes: [],
    },
    knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
    playbook: { script_atendimento: "" },
  };
}

describe("computeChangedSections", () => {
  it("returns every section when there is no base snapshot yet (never published)", () => {
    expect(computeChangedSections(baseSections(), null)).toEqual([
      "identity", "personality", "rules", "knowledge", "playbook",
    ]);
  });

  it("returns an empty array when the draft is identical to the base snapshot", () => {
    expect(computeChangedSections(baseSections(), baseSections())).toEqual([]);
  });

  it("returns only the sections that actually differ", () => {
    const base = baseSections();
    const draft = { ...base, identity: { ...base.identity, nome: "Helena 2.0" } };
    expect(computeChangedSections(draft, base)).toEqual(["identity"]);
  });

  it("detects a change nested inside an array field", () => {
    const base = baseSections();
    const draft = {
      ...base,
      rules: { ...base.rules, objecoes: [{ id: "a", nome: "Preço", como_identificar: "", orientacao: "", pergunta_diagnostico: "", quando_escalar: "", ativo: true }] },
    };
    expect(computeChangedSections(draft, base)).toEqual(["rules"]);
  });
});
