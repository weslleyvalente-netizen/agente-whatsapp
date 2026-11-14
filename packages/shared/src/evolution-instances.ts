// Seleção da instância Evolution que envia AVISOS INTERNOS (digest de leads sem resposta, alertas do monitor de saúde).
// NÃO é usada para escolher a instância das conversas comerciais: cada conversa continua presa à sua `evolution_instance_id`.
// Regra: só instâncias com agente ativo E comprovadamente conectadas (estado consultado na própria Evolution; o status gravado no
// banco não é confiável). Se a Evolution não puder ser consultada, as de estado desconhecido entram como último recurso.

export type LiveState = "open" | "connecting" | "close" | "unknown";

export interface InstanceCandidate {
  name: string;
  createdAt: string;
  activeAgent: boolean;
  liveState: LiveState;
}
export interface RankedInstance { name: string; verified: boolean }

/** Converte a resposta de /instance/connectionState em estado (formatos `{instance:{state}}` ou `{state}`). Qualquer outra coisa = unknown. */
export function normalizeConnectionState(raw: unknown): LiveState {
  const r = raw as { instance?: { state?: unknown }; state?: unknown } | null;
  const s = typeof r?.instance?.state === "string" ? r.instance.state : typeof r?.state === "string" ? r.state : null;
  if (s === "open" || s === "connecting" || s === "close") return s;
  return "unknown";
}

/**
 * Ordem de tentativa para um aviso interno:
 * 1) instâncias abertas (a preferida primeiro; depois a MAIS ANTIGA primeiro: a principal, não a recém-criada);
 * 2) se nenhuma está aberta mas há estado desconhecido (Evolution inalcançável), as desconhecidas, mesma ordem, como último recurso;
 * instâncias fechadas ou conectando nunca entram.
 */
export function rankSendInstances(candidates: InstanceCandidate[], opts: { preferred?: string | null } = {}): RankedInstance[] {
  const active = candidates.filter((c) => c.activeAgent);
  const order = (list: InstanceCandidate[]) => [...list].sort((a, b) => {
    const pa = opts.preferred && a.name === opts.preferred ? 0 : 1;
    const pb = opts.preferred && b.name === opts.preferred ? 0 : 1;
    return pa - pb || a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name);
  });
  const open = order(active.filter((c) => c.liveState === "open"));
  if (open.length) return open.map((c) => ({ name: c.name, verified: true }));
  return order(active.filter((c) => c.liveState === "unknown")).map((c) => ({ name: c.name, verified: false }));
}

/** Descrição curta e segura (sem número, sem chave) dos estados, para logs e mensagens de erro. */
export function describeInstanceStates(candidates: InstanceCandidate[]): string {
  return candidates.filter((c) => c.activeAgent).map((c) => `${c.name}=${c.liveState}`).join(", ") || "nenhuma instância com agente ativo";
}

/** Grupos de instâncias que reportam o MESMO número de WhatsApp (pareamento duplicado). Compara só dígitos. */
export function findDuplicateOwners(list: Array<{ name: string; ownerNumber?: string | null }>): string[][] {
  const byNumber = new Map<string, string[]>();
  for (const i of list) {
    const digits = (i.ownerNumber ?? "").replace(/\D/g, "");
    if (digits.length < 8) continue;
    byNumber.set(digits, [...(byNumber.get(digits) ?? []), i.name]);
  }
  return [...byNumber.values()].filter((names) => names.length > 1);
}

/** Lê o número dono de cada instância da resposta de /instance/fetchInstances (formatos plano ou `{instance:{...}}`). */
export function parseInstanceOwners(raw: unknown): Array<{ name: string; ownerNumber: string | null }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const i = ((item as { instance?: unknown })?.instance ?? item) as { name?: unknown; instanceName?: unknown; ownerJid?: unknown; owner?: unknown; number?: unknown };
    const name = typeof i.name === "string" ? i.name : typeof i.instanceName === "string" ? i.instanceName : null;
    const jid = [i.ownerJid, i.owner, i.number].find((v): v is string => typeof v === "string" && v.length > 0) ?? null;
    return name ? { name, ownerNumber: jid ? jid.split("@")[0].replace(/\D/g, "") || null : null } : null;
  }).filter((x): x is { name: string; ownerNumber: string | null } => x !== null);
}

/**
 * Mensagem de erro de envio útil para diagnóstico e sem segredos: status HTTP + a mensagem da Evolution (truncada).
 * Remove chaves de API, URLs e qualquer sequência de 8+ dígitos (telefones).
 */
export function sanitizeEvolutionError(status: number, body: string, max = 200): string {
  let text = body ?? "";
  try {
    const j = JSON.parse(text) as { response?: { message?: unknown }; message?: unknown; error?: unknown };
    const m = j?.response?.message ?? j?.message ?? j?.error;
    if (m !== undefined) text = typeof m === "string" ? m : JSON.stringify(m);
  } catch { /* corpo não é JSON: usa o texto cru */ }
  text = text
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(apikey|api[_-]?key|authorization|token|secret)["'\s:=]+(?:bearer\s+)?[^\s"',}]+/gi, "$1=[redacted]")
    .replace(/\d{8,}/g, "***")
    .replace(/\s+/g, " ").trim();
  return `Evolution API send error ${status}${text ? `: ${text.slice(0, max)}` : ""}`;
}

/** A Evolution respondeu e recusou o envio (nada foi entregue): seguro tentar a próxima instância. */
export class EvolutionRejectedError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "EvolutionRejectedError"; }
}
export interface AlertAttempt { instance: string; error: string }
/** Todas as instâncias elegíveis foram tentadas e recusaram (ou nenhuma estava conectada). Nada foi entregue. */
export class NoConnectedInstanceError extends Error {
  constructor(message: string, public readonly attempts: AlertAttempt[] = []) { super(message); this.name = "NoConnectedInstanceError"; }
}

/**
 * Entrega por UMA instância conectada. Recusa explícita (EvolutionRejectedError) passa para a próxima;
 * erro ambíguo (timeout/rede: a requisição pode ter saído) PARA e é repassado, para nunca duplicar o aviso.
 * Devolve o nome da instância que enviou.
 */
export async function deliverViaConnectedInstance(
  ranked: RankedInstance[], send: (instanceName: string) => Promise<void>, statesSummary = "",
): Promise<string> {
  if (!ranked.length) throw new NoConnectedInstanceError(`nenhuma instância conectada${statesSummary ? ` (${statesSummary})` : ""}`);
  const attempts: AlertAttempt[] = [];
  for (const r of ranked) {
    try { await send(r.name); return r.name; }
    catch (err) {
      if (err instanceof EvolutionRejectedError) { attempts.push({ instance: r.name, error: err.message }); continue; }
      throw err;
    }
  }
  throw new NoConnectedInstanceError(`todas as instâncias conectadas recusaram o envio: ${attempts.map((a) => `${a.instance}: ${a.error}`).join(" | ")}`, attempts);
}

/** Consulta o estado real da instância na Evolution. Nunca lança e nunca registra a chave; qualquer falha = unknown. */
export async function fetchConnectionState(
  o: { baseUrl: string; apiKey: string; instanceName: string; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<LiveState> {
  try {
    const res = await (o.fetchImpl ?? fetch)(`${o.baseUrl}/instance/connectionState/${encodeURIComponent(o.instanceName)}`, {
      headers: { apikey: o.apiKey }, signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
    if (!res.ok || typeof res.json !== "function") return "unknown";
    return normalizeConnectionState(await res.json());
  } catch { return "unknown"; }
}

/** Números donos das instâncias (para detectar pareamento duplicado). Nunca lança. */
export async function fetchInstanceOwners(
  o: { baseUrl: string; apiKey: string; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<Array<{ name: string; ownerNumber: string | null }>> {
  try {
    const res = await (o.fetchImpl ?? fetch)(`${o.baseUrl}/instance/fetchInstances`, { headers: { apikey: o.apiKey }, signal: AbortSignal.timeout(o.timeoutMs ?? 8000) });
    if (!res.ok || typeof res.json !== "function") return [];
    return parseInstanceOwners(await res.json());
  } catch { return []; }
}
