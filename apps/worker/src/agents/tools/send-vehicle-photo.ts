import { tool } from "ai";
import { z } from "zod";
import { createMessage, getAdminClient } from "@aula-agente/database";
import { getSendMessageQueue } from "@aula-agente/queue";
import { fetchCatalog, findVehicleByModel, resolveImageUrl } from "./search-catalog.js";

interface SendVehiclePhotoContext {
  conversationId: string;
  organizationId: string;
  instanceId: string;
  phone: string;
}

export function formatVehicleCaption(modelo: string, preco: number): string {
  return `${modelo} — R$ ${preco.toLocaleString("pt-BR")}`;
}

export function createSendVehiclePhotoTool(context: SendVehiclePhotoContext) {
  return tool({
    description:
      "Send the customer a real WhatsApp photo of a specific vehicle. Only call this after searchCatalog, using the exact modelo it returned for the vehicle the customer wants to see. This tool looks the vehicle up fresh in the catalog itself — it does not trust a remembered price or photo URL from earlier in the conversation.",
    inputSchema: z.object({
      modelo: z.string().describe("Exact vehicle model name from a prior searchCatalog result"),
    }),
    execute: async ({ modelo }) => {
      // Conversation history only ever stores the human-readable caption
      // (never a raw tool result), so on a later turn the model has no
      // reliable way to recall an exact price or image URL — it can only
      // recall the model name it said out loud. Re-fetching here removes
      // that guesswork instead of trusting a value the model might
      // misremember or fabricate.
      const vehicles = await fetchCatalog();
      const vehicle = findVehicleByModel(vehicles, modelo);
      if (!vehicle) {
        return `Veículo "${modelo}" não encontrado no catálogo. Confira o nome exato com searchCatalog antes de tentar de novo.`;
      }

      const caption = formatVehicleCaption(vehicle.modelo, vehicle.preco);
      const imageUrl = resolveImageUrl(vehicle.imageUrl);
      const db = getAdminClient();

      const message = await createMessage(db, {
        conversation_id: context.conversationId,
        organization_id: context.organizationId,
        evolution_message_id: null,
        role: "agent",
        content: caption,
        media_url: imageUrl,
        media_type: "image",
        metadata: null,
      });

      const sendQueue = getSendMessageQueue();
      await sendQueue.add("send-message", {
        conversationId: context.conversationId,
        messageId: message.id,
        instanceId: context.instanceId,
        phone: context.phone,
        content: caption,
        mediaUrl: imageUrl,
        mediaType: "image",
        caption,
        organizationId: context.organizationId,
      });

      return "Foto enviada.";
    },
  });
}
