import { chatDayKey } from "@aula-agente/shared";

// Layout das Conversas no estilo WhatsApp Web (atrás da flag
// inbox_whatsapp_layout_enabled). Só helpers puros e strings de classe —
// os componentes decidem quando usá-los.

export type MessageTick = "sent" | "failed";

interface TickInput {
  role: string;
  evolution_message_id: string | null;
  metadata: { send_failed_at?: string } | null;
}

const OUTBOUND_ROLES = new Set(["agent", "human_agent"]);

// Não há dado de entrega/leitura: o máximo que sabemos é que o WhatsApp
// aceitou a mensagem (tem evolution_message_id) ou que o envio falhou.
// Por isso só um ✓, nunca o duplo.
export function messageTick(m: TickInput): MessageTick | null {
  if (!OUTBOUND_ROLES.has(m.role)) return null;
  if (m.metadata?.send_failed_at) return "failed";
  if (m.evolution_message_id) return "sent";
  return null;
}

type Side = "in" | "out" | "system";

function sideOf(role: string): Side {
  if (role === "contact") return "in";
  if (role === "system") return "system";
  return "out";
}

interface GroupInput {
  role: string;
  created_at: string;
}

// O "rabinho" só aparece na primeira bolha de uma sequência do mesmo lado
// (como no WhatsApp). Troca de lado, mensagem de sistema ou troca de dia
// começam um grupo novo.
export function startsBubbleGroup(prev: GroupInput | undefined, cur: GroupInput): boolean {
  if (!prev) return true;
  const prevSide = sideOf(prev.role);
  if (prevSide === "system") return true;
  if (prevSide !== sideOf(cur.role)) return true;
  return chatDayKey(prev.created_at) !== chatDayKey(cur.created_at);
}

// Altura do campo do composer: acompanha o conteúdo (scrollHeight, já com o
// padding) entre 1 e `maxRows` linhas.
export function composerHeight(scrollHeight: number, lineHeight: number, paddingY: number, maxRows: number): number {
  const min = lineHeight + paddingY;
  const max = lineHeight * maxRows + paddingY;
  return Math.min(Math.max(scrollHeight, min), max);
}

// Strings de classe Tailwind do tema. Ficam literais para o scanner do
// Tailwind enxergar as cores arbitrárias.
export const WA_THEME = {
  // Fundo bege do chat.
  chatBg: "bg-[#efeae2] dark:bg-[#0b141a]",
  // Cabeçalhos (lista e chat) e barra do composer.
  header: "bg-[#f0f2f5] dark:bg-[#202c33]",
  // Painel da lista e estado vazio.
  panel: "bg-white dark:bg-[#111b21]",
  bubbleIn: "bg-white text-[#111b21] dark:bg-[#202c33] dark:text-[#e9edef]",
  bubbleOut: "bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]",
  // Mensagens da IA: azul claro, para não se confundir com as do vendedor (verde).
  bubbleAi: "bg-[#dbeafe] text-[#111b21] dark:bg-[#1e3a5f] dark:text-[#e9edef]",
  // Cor do "rabinho" (mesma do balão, aplicada como text-* no SVG com fill=currentColor).
  tailIn: "text-white dark:text-[#202c33]",
  tailOut: "text-[#d9fdd3] dark:text-[#005c4b]",
  tailAi: "text-[#dbeafe] dark:text-[#1e3a5f]",
  accentBg: "bg-[#00a884] text-white hover:bg-[#008f72] dark:bg-[#00a884] dark:hover:bg-[#06cf9c]",
  accentText: "text-[#00a884] dark:text-[#00a884]",
  aiText: "text-[#2563eb] dark:text-[#7db3ff]",
  unreadDot: "bg-[#25d366] dark:bg-[#00a884]",
  meta: "text-[#667781] dark:text-[#8696a0]",
  title: "text-[#111b21] dark:text-[#e9edef]",
  listItem: "hover:bg-[#f5f6f6] dark:hover:bg-[#202c33]",
  listItemSelected: "bg-[#f0f2f5] dark:bg-[#2a3942]",
  divider: "border-[#e9edef] dark:border-[#222d34]",
  input: "bg-white text-[#111b21] placeholder:text-[#667781] dark:bg-[#2a3942] dark:text-[#e9edef] dark:placeholder:text-[#8696a0]",
  search: "bg-[#f0f2f5] dark:bg-[#202c33]",
  dayPill: "bg-white text-[#54656f] dark:bg-[#182229] dark:text-[#8696a0]",
  systemPill: "bg-[#ffeecd] text-[#54656f] dark:bg-[#182229] dark:text-[#8696a0]",
} as const;
