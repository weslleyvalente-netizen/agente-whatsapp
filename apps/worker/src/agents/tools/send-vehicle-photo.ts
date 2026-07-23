import { tool } from "ai";
import { z } from "zod";
import { createMessage, getAdminClient } from "@aula-agente/database";
import { getSendMessageQueue } from "@aula-agente/queue";

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
      "Send the customer a real WhatsApp photo of a specific vehicle. Only call this after searchCatalog, using the exact modelo, preco, and imageUrl it returned for the vehicle the customer wants to see.",
    inputSchema: z.object({
      modelo: z.string().describe("Exact vehicle model name from a prior searchCatalog result"),
      preco: z.number().describe("Exact vehicle price from a prior searchCatalog result"),
      imageUrl: z.string().describe("Exact fully-qualified image URL from a prior searchCatalog result"),
    }),
    execute: async ({ modelo, preco, imageUrl }) => {
      const caption = formatVehicleCaption(modelo, preco);
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
