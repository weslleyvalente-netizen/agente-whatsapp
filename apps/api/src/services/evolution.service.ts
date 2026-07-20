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
