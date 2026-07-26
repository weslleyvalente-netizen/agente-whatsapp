import type {
  AgentConfigSections,
  AgentIdentity,
  AgentPersonality,
  AgentRules,
  AgentKnowledgeConfig,
  AgentPlaybook,
} from "./types/agent-config.js";

function compileIdentitySection(identity: AgentIdentity): string {
  const lines: string[] = [];
  if (identity.nome) lines.push(`Nome: ${identity.nome}`);
  if (identity.funcao) lines.push(`Função: ${identity.funcao}`);
  if (identity.missao) lines.push("", identity.missao);
  if (lines.length === 0) return "";
  return ["# Identidade", ...lines].join("\n");
}

const TOM_DE_VOZ_LABELS: Record<AgentPersonality["tom_de_voz"], string> = {
  profissional: "Profissional",
  equilibrado: "Equilibrado",
  amigavel: "Amigável",
  divertido: "Divertido",
  personalizado: "Personalizado",
};

const TAMANHO_RESPOSTA_LABELS: Record<AgentPersonality["tamanho_resposta"], string> = {
  curta: "Curta",
  media: "Média",
  detalhada: "Detalhada",
};

function compilePersonalitySection(personality: AgentPersonality): string {
  const lines = ["# Personalidade"];

  const tom =
    personality.tom_de_voz === "personalizado" && personality.tom_de_voz_personalizado
      ? personality.tom_de_voz_personalizado
      : TOM_DE_VOZ_LABELS[personality.tom_de_voz];
  lines.push(`Tom de voz: ${tom}`);
  lines.push(`Tamanho das respostas: ${TAMANHO_RESPOSTA_LABELS[personality.tamanho_resposta]}`);

  if (personality.emojis.ativo) {
    const instrucao = personality.emojis.instrucao ? ` ${personality.emojis.instrucao}` : "";
    lines.push(`Emojis: no máximo ${personality.emojis.maximo} por mensagem.${instrucao}`);
  } else {
    lines.push("Emojis: não usar.");
  }

  lines.push(`Faça no máximo ${personality.perguntas_por_vez.maximo} pergunta(s) por mensagem.`);

  if (personality.postura_comercial.tipo || personality.postura_comercial.instrucao) {
    const tipo = personality.postura_comercial.tipo ? `${personality.postura_comercial.tipo}. ` : "";
    lines.push(`Postura comercial: ${tipo}${personality.postura_comercial.instrucao}`.trim());
  }

  if (personality.girias_proibidas.length > 0) {
    lines.push(`Nunca use estas expressões: ${personality.girias_proibidas.join(", ")}.`);
  }

  if (personality.proatividade) {
    lines.push("", personality.proatividade);
  }

  return lines.join("\n");
}

function compileRulesSection(rules: AgentRules): string {
  const blocks: string[] = [];

  const handoff = rules.transferencia_para_humano.filter((r) => r.ativo);
  if (handoff.length > 0) {
    blocks.push(["## Transferência para humano", ...handoff.map((r) => `- ${r.label}: ${r.instrucao}`)].join("\n"));
  }

  const promises = rules.promessas_proibidas.filter((r) => r.ativo);
  if (promises.length > 0) {
    blocks.push(["## Promessas proibidas", ...promises.map((r) => `- ${r.instrucao}`)].join("\n"));
  }

  const byType = rules.regras_por_tipo.filter((r) => r.ativo);
  if (byType.length > 0) {
    blocks.push(
      ["## Regras por tipo de atendimento", ...byType.flatMap((r) => [`### ${r.categoria}`, r.instrucao])].join("\n")
    );
  }

  const pd = rules.preco_desconto;
  if (pd.pode_autonomo || pd.exige_humano || pd.nunca_pode || pd.observacoes) {
    const pdLines = ["## Preço e desconto"];
    if (pd.pode_autonomo) pdLines.push(`Pode informar sozinho: ${pd.pode_autonomo}`);
    if (pd.exige_humano) pdLines.push(`Exige humano: ${pd.exige_humano}`);
    if (pd.nunca_pode) pdLines.push(`Nunca pode: ${pd.nunca_pode}`);
    if (pd.observacoes) pdLines.push(`Observações: ${pd.observacoes}`);
    blocks.push(pdLines.join("\n"));
  }

  const objections = rules.objecoes.filter((o) => o.ativo);
  if (objections.length > 0) {
    blocks.push(
      [
        "## Objeções",
        ...objections.flatMap((o) => [
          `### ${o.nome}`,
          `Como identificar: ${o.como_identificar}`,
          `Orientação: ${o.orientacao}`,
          `Pergunta de diagnóstico: ${o.pergunta_diagnostico}`,
          `Quando escalar: ${o.quando_escalar}`,
        ]),
      ].join("\n")
    );
  }

  if (blocks.length === 0) return "";
  return ["# Regras", ...blocks].join("\n\n");
}

function compileKnowledgeSection(knowledge: AgentKnowledgeConfig): string {
  const blocks: string[] = [];
  if (knowledge.precos_notas) {
    blocks.push(["# Preços", knowledge.precos_notas].join("\n"));
  }
  const activeLinks = knowledge.links.filter((l) => l.ativo);
  if (activeLinks.length > 0) {
    blocks.push(["# Links úteis", ...activeLinks.map((l) => `- ${l.titulo}: ${l.url}`)].join("\n"));
  }
  return blocks.join("\n\n");
}

function compilePlaybookSection(playbook: AgentPlaybook): string {
  if (!playbook.script_atendimento) return "";
  return ["# Playbook: Script de atendimento", playbook.script_atendimento].join("\n");
}

export function compileSystemPrompt(config: AgentConfigSections): string {
  const sections = [
    compileIdentitySection(config.identity),
    compilePersonalitySection(config.personality),
    compileRulesSection(config.rules),
    compileKnowledgeSection(config.knowledge),
    compilePlaybookSection(config.playbook),
  ].filter((section) => section.trim().length > 0);

  return sections.join("\n\n");
}
