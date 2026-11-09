// Evento "messages.update" do Evolution: status de uma mensagem que NÓS enviamos
// (entregue / lida). Parser tolerante: qualquer formato inesperado vira null.

export interface DeliveryStatusUpdate {
  instance: string;
  /** id da mensagem no WhatsApp (o mesmo guardado em messages.evolution_message_id). */
  messageId: string;
  status: "delivered" | "read";
}

function eventName(body: unknown): string {
  const e = (body as { event?: unknown } | null)?.event;
  return typeof e === "string" ? e.toLowerCase().replace(/_/g, ".") : "";
}

export function isEvolutionStatusEvent(body: unknown): boolean {
  return eventName(body) === "messages.update";
}

const STATUS_MAP: Record<string, DeliveryStatusUpdate["status"]> = {
  delivery_ack: "delivered",
  delivered: "delivered",
  read: "read",
  played: "read",
};

export function parseEvolutionStatusUpdate(body: unknown): DeliveryStatusUpdate | null {
  if (!isEvolutionStatusEvent(body)) return null;
  const b = body as { instance?: unknown; data?: unknown };
  if (typeof b.instance !== "string" || !b.instance) return null;
  const raw = Array.isArray(b.data) ? b.data[0] : b.data;
  if (!raw || typeof raw !== "object") return null;
  const d = raw as { keyId?: unknown; messageId?: unknown; key?: { id?: unknown }; status?: unknown; fromMe?: unknown };
  // Só mensagens nossas; fromMe ausente é tolerado (a busca no banco filtra por papel).
  if (d.fromMe === false) return null;
  const status = typeof d.status === "string" ? STATUS_MAP[d.status.toLowerCase()] : undefined;
  if (!status) return null;
  const id = [d.keyId, d.key?.id, d.messageId].find((v): v is string => typeof v === "string" && v.length > 0);
  if (!id) return null;
  return { instance: b.instance, messageId: id, status };
}
