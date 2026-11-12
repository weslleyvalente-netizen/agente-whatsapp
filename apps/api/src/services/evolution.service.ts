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
        events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE"],
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
  key: { remoteJid: string; remoteJidAlt?: string | null; fromMe: boolean; id: string };
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

// Poucas mensagens de um único chat (remoteJid exato), qualquer direção; usado para descobrir o telefone de um @lid.
export async function findMessagesByRemoteJid(
  instanceName: string,
  remoteJid: string,
  limit: number,
  signal?: AbortSignal
): Promise<EvolutionStoredMessage[]> {
  const result = await evolutionFetch(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    signal,
    body: JSON.stringify({ where: { key: { remoteJid } }, page: 1, offset: limit }),
  });
  return extractRecords(result);
}


// ---- Observação periódica (monitor de conexão) ----
// Consultas curtas e com tempo limite, só para o monitor. Devolvem apenas estados e horários: nunca o corpo bruto da
// resposta (disconnectionObject e outros campos podem ter dados de sessão).
export const OBSERVE_TIMEOUT_MS = 10_000;
const OBSERVE_PAGE_SIZE = 50;

export function parseConnectionState(res: any): string | null {
  const state = res?.instance?.state ?? res?.state;
  return typeof state === "string" && state.length > 0 ? state : null;
}

/** Resposta da Evolution que não tem o formato esperado (instância ausente, corpo inesperado). Não é o mesmo que "sem desconexão". */
export class ObserveInvalidResponseError extends Error {
  constructor() { super("invalid_response"); this.name = "ObserveInvalidResponseError"; }
}

/** null = resposta inválida ou instância ausente. {at:null, reasonCode:null} = instância presente e sem desconexão registrada. */
export function parseDisconnection(res: any, instanceName: string): { at: Date | null; reasonCode: number | null } | null {
  const list: any[] = Array.isArray(res) ? res : res && typeof res === "object" ? [res] : [];
  const item = list.find((i) => i && (i.name === instanceName || i.instance?.instanceName === instanceName));
  if (!item) return null;
  const at = item.disconnectionAt ? new Date(item.disconnectionAt) : null;
  const code = Number(item.disconnectionReasonCode);
  return {
    at: at && Number.isFinite(at.getTime()) ? at : null,
    reasonCode: item.disconnectionReasonCode !== null && item.disconnectionReasonCode !== undefined && Number.isFinite(code) ? code : null,
  };
}

export function newestReceivedTimestamp(records: EvolutionStoredMessage[]): Date | null {
  const stamps = records.map(tsSec).filter((t) => Number.isFinite(t) && t > 0);
  return stamps.length > 0 ? new Date(Math.max(...stamps) * 1000) : null;
}

/** Só a classe do erro: o texto da Evolution pode conter URL, chave ou corpo da resposta. */
export function classifyObserveError(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  if (e instanceof ObserveInvalidResponseError) return "invalid_response";
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout";
  const m = /Evolution API error (\d{3})/.exec(String(e?.message ?? ""));
  if (m) return `http_${m[1]}`;
  if (e instanceof TypeError) return "network";
  return "unknown";
}

export async function observeConnectionState(instanceName: string): Promise<string | null> {
  return parseConnectionState(await evolutionFetch(`/instance/connectionState/${encodeURIComponent(instanceName)}`, { signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS) }));
}

export async function observeDisconnection(instanceName: string): Promise<{ at: Date | null; reasonCode: number | null }> {
  const res = await evolutionFetch(`/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`, { signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS) });
  const parsed = parseDisconnection(res, instanceName);
  if (parsed === null) throw new ObserveInvalidResponseError();
  return parsed;
}

/**
 * Horário da mensagem RECEBIDA mais recente que a Evolution guardou. Não infere a ordenação (varia entre versões e pode ter horários
 * iguais): olha a primeira e a última página e fica com o maior horário. Lista vazia é "sem mensagens" (null); resposta sem lista
 * de mensagens é inválida. É sinal de atividade, não prova de perda: para provar atraso, correlacione uma mensagem de teste nos dois lados.
 */
export async function observeLatestReceivedAt(instanceName: string): Promise<Date | null> {
  const fetchPage = (page: number) => evolutionFetch(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS),
    body: JSON.stringify({ where: { key: { fromMe: false } }, page, offset: OBSERVE_PAGE_SIZE }),
  });
  const hasRecords = (r: any) => Array.isArray(r) || Array.isArray(r?.messages?.records) || Array.isArray(r?.messages);
  const first = await fetchPage(1);
  if (!hasRecords(first)) throw new ObserveInvalidResponseError();
  const records = extractRecords(first);
  const pages = typeof first?.messages?.pages === "number" ? first.messages.pages : 1;
  if (pages > 1) {
    const last = await fetchPage(pages);
    if (!hasRecords(last)) throw new ObserveInvalidResponseError();
    records.push(...extractRecords(last));
  }
  return newestReceivedTimestamp(records);
}
