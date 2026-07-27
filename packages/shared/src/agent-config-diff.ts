import type { AgentConfigSections } from "./types/agent-config.js";
import { SECTION_ITEMS, SECTION_LABELS, DRAFT_KEY_TO_SECTION, type SectionKey } from "./agent-config-sections.js";

const SECTION_KEYS = ["identity", "personality", "rules", "knowledge", "playbook"] as const;

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function computeChangedSections(
  draft: AgentConfigSections,
  baseSnapshot: AgentConfigSections | null
): Array<(typeof SECTION_KEYS)[number]> {
  if (!baseSnapshot) return [...SECTION_KEYS];
  return SECTION_KEYS.filter((key) => !deepEqual(draft[key], baseSnapshot[key]));
}

// Bridges each backend section (identity/personality/...) to the UI item
// keys defined in agent-config-sections.ts's SECTION_ITEMS, so the publish
// dialog can show "Personalidade > Emojis" instead of just "Personalidade".
const ITEM_FIELD_MAP: Partial<Record<(typeof SECTION_KEYS)[number], Record<string, string>>> = {
  personality: {
    tom_de_voz: "tom_de_voz",
    emojis: "emojis",
    perguntas_por_vez: "perguntas_por_vez",
    postura_comercial: "postura_comercial",
    girias: "girias_proibidas",
    proatividade: "proatividade",
  },
  rules: {
    transferencia: "transferencia_para_humano",
    promessas: "promessas_proibidas",
    regras_por_tipo: "regras_por_tipo",
    preco_desconto: "preco_desconto",
    objecoes: "objecoes",
  },
  knowledge: {
    documentos: "documentos_ativos",
    faq: "faqs_ativas",
    precos: "precos_notas",
    links: "links",
  },
};

export interface ChangedSectionDetail {
  section: SectionKey;
  label: string;
  items: { key: string; label: string }[];
}

export function computeChangedSectionDetails(
  draft: AgentConfigSections,
  baseSnapshot: AgentConfigSections | null
): ChangedSectionDetail[] {
  const changedDraftKeys = computeChangedSections(draft, baseSnapshot);

  return changedDraftKeys.map((draftKey) => {
    const section = DRAFT_KEY_TO_SECTION[draftKey];
    const label = SECTION_LABELS[section];
    const itemFieldMap = ITEM_FIELD_MAP[draftKey];
    const uiItems = SECTION_ITEMS[section];

    if (!itemFieldMap || !uiItems) return { section, label, items: [] };
    if (!baseSnapshot) {
      return { section, label, items: Object.entries(uiItems).map(([key, itemLabel]) => ({ key, label: itemLabel })) };
    }

    const draftSection = draft[draftKey] as unknown as Record<string, unknown>;
    const baseSection = baseSnapshot[draftKey] as unknown as Record<string, unknown>;
    const items = Object.entries(itemFieldMap)
      .filter(([, fieldKey]) => !deepEqual(draftSection[fieldKey], baseSection[fieldKey]))
      .map(([itemKey]) => ({ key: itemKey, label: uiItems[itemKey] }));

    return { section, label, items };
  });
}
