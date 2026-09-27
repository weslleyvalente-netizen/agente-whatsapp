import { tool, type Tool } from "ai";
import { z } from "zod";
import type { AgentImageItem } from "@aula-agente/shared";
import { createMessage, getAdminClient, getAgentConfigIfExists, getLatestAgentVersion } from "@aula-agente/database";
import { getSendMessageQueue } from "@aula-agente/queue";

export type ImageLoader = () => Promise<AgentImageItem[]>;

interface SendRegisteredImageContext {
  conversationId: string;
  organizationId: string;
  instanceId: string;
  phone: string;
}

const DESCRIPTION =
  "Envia ao cliente, pelo WhatsApp, uma imagem cadastrada no Conhecimento (seção \"Imagens cadastradas\" do prompt). Use o id exato listado lá e só quando a situação de \"Quando enviar\" acontecer.";

const inputSchema = z.object({
  imagem_id: z.string().describe("id exato da imagem, como aparece em \"Imagens cadastradas\""),
});

// Customer-facing sends must only ever use what's published: an image added
// to the draft but not yet published doesn't exist for real conversations.
export async function loadPublishedImages(agentId: string): Promise<AgentImageItem[]> {
  const version = await getLatestAgentVersion(getAdminClient(), agentId);
  return version?.config_snapshot.knowledge.imagens ?? [];
}

// The playground tests the draft being edited, so it resolves from there.
export async function loadDraftImages(agentId: string): Promise<AgentImageItem[]> {
  const draft = await getAgentConfigIfExists(getAdminClient(), agentId);
  return draft?.knowledge.imagens ?? [];
}

type Resolution = { ok: true; image: AgentImageItem } | { ok: false; message: string };

async function resolveImage(loadImages: ImageLoader, imagemId: string): Promise<Resolution> {
  const image = (await loadImages()).find((i) => i.id === imagemId);
  if (!image) {
    return { ok: false, message: `Imagem "${imagemId}" não está cadastrada na versão publicada — não diga ao cliente que enviou.` };
  }
  if (!image.ativo) {
    return { ok: false, message: `Imagem "${image.titulo}" está desativada — não diga ao cliente que enviou.` };
  }
  return { ok: true, image };
}

export function createSendRegisteredImageTool(context: SendRegisteredImageContext, loadImages: ImageLoader): Tool {
  return tool({
    description: DESCRIPTION,
    inputSchema,
    execute: async ({ imagem_id }) => {
      try {
        const resolved = await resolveImage(loadImages, imagem_id);
        if (!resolved.ok) return resolved.message;
        const { image } = resolved;

        const message = await createMessage(getAdminClient(), {
          conversation_id: context.conversationId,
          organization_id: context.organizationId,
          evolution_message_id: null,
          role: "agent",
          content: image.legenda,
          media_url: image.url,
          media_type: "image",
          metadata: null,
        });

        await getSendMessageQueue().add("send-message", {
          conversationId: context.conversationId,
          messageId: message.id,
          instanceId: context.instanceId,
          phone: context.phone,
          content: image.legenda,
          mediaUrl: image.url,
          mediaType: "image",
          caption: image.legenda,
          organizationId: context.organizationId,
        });

        return "Imagem enviada.";
      } catch (err) {
        console.error("sendRegisteredImage tool failed:", err);
        return "Não foi possível enviar a imagem agora — não diga ao cliente que enviou.";
      }
    },
  });
}

export function createMockSendRegisteredImageTool(loadImages: ImageLoader): Tool {
  return tool({
    description: `${DESCRIPTION} Estamos no Playground de testes — nenhuma mensagem real é enviada.`,
    inputSchema,
    execute: async ({ imagem_id }) => {
      const resolved = await resolveImage(loadImages, imagem_id);
      if (!resolved.ok) return resolved.message;
      return `[SIMULADO] Imagem "${resolved.image.titulo}" seria enviada pelo WhatsApp agora, com a legenda: ${resolved.image.legenda}`;
    },
  });
}
