import { describe, it, expect } from "vitest";
import { computeChangedSections, computeChangedSectionDetails, type DiffableConfig } from "./agent-config-diff.js";

function baseSections(): DiffableConfig {
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
    tools_config: { search_faq: true, create_task: true, search_knowledge: true, send_catalog_photo: true, update_qualification: false },
  };
}

describe("computeChangedSections", () => {
  it("returns every section when there is no base snapshot yet (never published)", () => {
    expect(computeChangedSections(baseSections(), null)).toEqual([
      "identity", "personality", "rules", "knowledge", "playbook", "tools_config",
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

  it("detects a tools_config-only change (regression: this used to never surface)", () => {
    const base = baseSections();
    const draft = { ...base, tools_config: { ...base.tools_config!, update_qualification: true } };
    expect(computeChangedSections(draft, base)).toEqual(["tools_config"]);
  });

  it("treats a missing tools_config on both sides as unchanged", () => {
    const base = baseSections();
    const { tools_config: _baseTools, ...baseWithoutTools } = base;
    const { tools_config: _draftTools, ...draftWithoutTools } = base;
    expect(computeChangedSections(draftWithoutTools, baseWithoutTools)).toEqual([]);
  });
});

describe("computeChangedSectionDetails", () => {
  it("returns every item for every section when there is no base snapshot yet", () => {
    const details = computeChangedSectionDetails(baseSections(), null);
    const personalidade = details.find((d) => d.section === "personalidade");
    expect(personalidade?.items.map((i) => i.key).sort()).toEqual(
      ["emojis", "girias", "perguntas_por_vez", "postura_comercial", "proatividade", "tom_de_voz"].sort()
    );
  });

  it("returns only the item that actually changed within Personalidade", () => {
    const base = baseSections();
    const draft = { ...base, personality: { ...base.personality, proatividade: "novo texto" } };
    expect(computeChangedSectionDetails(draft, base)).toEqual([
      { section: "personalidade", label: "Personalidade", items: [{ key: "proatividade", label: "Proatividade" }] },
    ]);
  });

  it("returns no item breakdown for Geral (a section with no items)", () => {
    const base = baseSections();
    const draft = { ...base, identity: { ...base.identity, nome: "Helena 2.0" } };
    expect(computeChangedSectionDetails(draft, base)).toEqual([{ section: "geral", label: "Geral", items: [] }]);
  });

  it("returns nothing when the draft matches the base snapshot", () => {
    expect(computeChangedSectionDetails(baseSections(), baseSections())).toEqual([]);
  });

  it("attributes a change in tom_de_voz_personalizado to the Tom de voz item, not just the bare section", () => {
    const base = baseSections();
    const draft = { ...base, personality: { ...base.personality, tom_de_voz_personalizado: "Texto novo do tom personalizado." } };
    expect(computeChangedSectionDetails(draft, base)).toEqual([
      { section: "personalidade", label: "Personalidade", items: [{ key: "tom_de_voz", label: "Tom de voz" }] },
    ]);
  });
});
