const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;

interface SendTextPayload {
  number: string;
  text: string;
}

async function evolutionFetch(path: string, options: RequestInit = {}) {
  const response = await fetch(`${EVOLUTION_API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Evolution API error ${response.status}: ${body}`);
  }

  return response.json();
}

export async function createInstance(instanceName: string, webhookUrl: string) {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  return evolutionFetch("/instance/create", {
    method: "POST",
    body: JSON.stringify({
      instanceName,
      integration: "WHATSAPP-BAILEYS",
      webhook: {
        url: webhookUrl,
        webhookByEvents: false,
        webhookBase64: false,
        events: ["MESSAGES_UPSERT"],
        ...(webhookSecret ? { headers: { apikey: webhookSecret } } : {}),
      },
    }),
  });
}

export async function getInstanceStatus(instanceName: string) {
  return evolutionFetch(`/instance/connectionState/${instanceName}`);
}

export async function getInstanceQrCode(instanceName: string) {
  return evolutionFetch(`/instance/connect/${instanceName}`);
}

export async function sendText(instanceName: string, payload: SendTextPayload) {
  return evolutionFetch(`/message/sendText/${instanceName}`, {
    method: "POST",
    body: JSON.stringify({
      number: payload.number,
      text: payload.text,
    }),
  });
}

export async function deleteInstance(instanceName: string) {
  return evolutionFetch(`/instance/delete/${instanceName}`, {
    method: "DELETE",
  });
}

export async function logoutInstance(instanceName: string) {
  return evolutionFetch(`/instance/logout/${instanceName}`, {
    method: "DELETE",
  });
}

export interface EvolutionStoredMessage {
  key: { remoteJid: string; fromMe: boolean; id: string };
  pushName?: string | null;
  message?: Record<string, unknown> | null;
  messageType: string;
  messageTimestamp?: number | string;
  contextInfo?: Record<string, unknown> | null;
  [extra: string]: unknown;
}

const FIND_MESSAGES_PAGE_SIZE = 100;
const FIND_MESSAGES_MAX_PAGES = 500;

// Mensagens recebidas (fromMe=false) que a Evolution guardou na janela [gteSec, lteSec] (epoch em segundos).
// Pagina até esgotar. A resposta varia entre versões: lista pura ou { messages: { records, pages } }.
export async function findReceivedMessages(
  instanceName: string,
  window: { gteSec: number; lteSec: number }
): Promise<EvolutionStoredMessage[]> {
  const all: EvolutionStoredMessage[] = [];
  for (let page = 1; page <= FIND_MESSAGES_MAX_PAGES; page++) {
    const result = await evolutionFetch(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({
        where: { key: { fromMe: false }, messageTimestamp: { gte: window.gteSec, lte: window.lteSec } },
        page,
        offset: FIND_MESSAGES_PAGE_SIZE,
      }),
    });
    const records: EvolutionStoredMessage[] = Array.isArray(result)
      ? result
      : Array.isArray(result?.messages?.records)
        ? result.messages.records
        : Array.isArray(result?.messages)
          ? result.messages
          : [];
    all.push(...records);
    const totalPages = typeof result?.messages?.pages === "number" ? result.messages.pages : 1;
    if (page >= totalPages || records.length === 0) break;
  }
  return all;
}
