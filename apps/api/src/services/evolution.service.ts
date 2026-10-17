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

function extractRecords(result: any): EvolutionStoredMessage[] {
  return Array.isArray(result)
    ? result
    : Array.isArray(result?.messages?.records)
      ? result.messages.records
      : Array.isArray(result?.messages)
        ? result.messages
        : [];
}

const tsSec = (r: EvolutionStoredMessage) => Number(r.messageTimestamp);

async function pageThrough(
  instanceName: string,
  where: Record<string, unknown>,
  onPage: (records: EvolutionStoredMessage[]) => boolean | void
): Promise<number> {
  let pages = 0;
  for (let page = 1; page <= FIND_MESSAGES_MAX_PAGES; page++) {
    const result = await evolutionFetch(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ where, page, offset: FIND_MESSAGES_PAGE_SIZE }),
    });
    const records = extractRecords(result);
    pages++;
    if (onPage(records) === false) break;
    const totalPages = typeof result?.messages?.pages === "number" ? result.messages.pages : 1;
    if (page >= totalPages || records.length === 0) break;
  }
  return pages;
}

// Mensagens que a Evolution guardou na janela [gteSec, lteSec] (epoch em segundos); fromMe=false são as recebidas.
// A resposta varia entre versões: lista pura ou { messages: { records, pages } }.
// Algumas versões ignoram/rejeitam o filtro por messageTimestamp e devolvem vazio: nesse caso (e só nele)
// refaz a busca sem filtro de data, paginando e filtrando aqui.
export async function findStoredMessages(
  instanceName: string,
  window: { gteSec: number; lteSec: number },
  fromMe: boolean
): Promise<EvolutionStoredMessage[]> {
  const filtered: EvolutionStoredMessage[] = [];
  const filteredPages = await pageThrough(
    instanceName,
    { key: { fromMe }, messageTimestamp: { gte: window.gteSec, lte: window.lteSec } },
    (records) => { filtered.push(...records); }
  );
  if (filtered.length > 0) return filtered;

  const inWindow: EvolutionStoredMessage[] = [];
  let scanned = 0;
  let newestFirst: boolean | null = null;
  const pages = await pageThrough(instanceName, { key: { fromMe } }, (records) => {
    scanned += records.length;
    const stamps = records.map(tsSec).filter(Number.isFinite);
    if (newestFirst === null && stamps.length > 1) newestFirst = stamps[0] >= stamps[stamps.length - 1];
    for (const r of records) {
      const t = tsSec(r);
      if (Number.isFinite(t) && t >= window.gteSec && t <= window.lteSec) inWindow.push(r);
    }
    // Ordem decrescente e a página inteira já é anterior à janela: não há mais nada a buscar.
    if (newestFirst && stamps.length > 0 && Math.max(...stamps) < window.gteSec) return false;
  });
  console.warn(
    `[evolution] findMessages com filtro de data veio vazio (${filteredPages} pág.); busca sem filtro: instância=${instanceName} fromMe=${fromMe} páginas=${pages} lidas=${scanned} na janela=${inWindow.length}`
  );
  return inWindow;
}
