export const SECTION_ORDER = ["geral", "personalidade", "regras", "conhecimento", "playbooks", "ferramentas"] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];

export const SECTION_ITEMS: Record<SectionKey, Record<string, string> | null> = {
  geral: null,
  personalidade: {
    tom_de_voz: "Tom de voz",
    emojis: "Emojis",
    perguntas_por_vez: "Perguntas por vez",
    postura_comercial: "Postura comercial",
    girias: "Gírias proibidas",
    proatividade: "Proatividade",
  },
  regras: {
    transferencia: "Transferência para humano",
    promessas: "Promessas proibidas",
    regras_por_tipo: "Regras por tipo de atendimento",
    preco_desconto: "Preço e desconto",
    objecoes: "Objeções",
  },
  conhecimento: {
    documentos: "Base de Conhecimento",
    faq: "FAQ",
    precos: "Preços",
    links: "Links",
  },
  playbooks: null,
  ferramentas: null,
};

export const SECTION_LABELS: Record<SectionKey, string> = {
  geral: "Geral",
  personalidade: "Personalidade",
  regras: "Regras",
  conhecimento: "Conhecimento",
  playbooks: "Playbooks",
  ferramentas: "Ferramentas",
};

export type DraftSectionKey = "identity" | "personality" | "rules" | "knowledge" | "playbook" | "tools_config";

export const SECTION_TO_DRAFT_KEY: Record<SectionKey, DraftSectionKey> = {
  geral: "identity",
  personalidade: "personality",
  regras: "rules",
  conhecimento: "knowledge",
  playbooks: "playbook",
  ferramentas: "tools_config",
};

export const DRAFT_KEY_TO_SECTION: Record<DraftSectionKey, SectionKey> = {
  identity: "geral",
  personality: "personalidade",
  rules: "regras",
  knowledge: "conhecimento",
  playbook: "playbooks",
  tools_config: "ferramentas",
};
