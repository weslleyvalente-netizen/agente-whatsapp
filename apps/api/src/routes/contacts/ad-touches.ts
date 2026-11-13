import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdminClient } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { canViewLead } from "../../lib/lead-access.js";
import { getAdOriginForContact } from "../../services/lead-ad-origin.service.js";

const paramsSchema = z.object({ contactId: z.string().uuid() });

// Detalhes da origem por anúncio de um contato (tela de atendimento). Só membros da organização do contato; o lead
// precisa ser visível ao usuário (mesma regra das fotos de perfil: sem conversa, ou alguma conversa visível).
export default async function adTouchesRoutes(app: FastifyInstance) {
  app.get("/contacts/:contactId/ad-touches", {
    preHandler: [authMiddleware],
    handler: async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: "Invalid contact id" });
      const db = getAdminClient();

      const { data: contact, error: contactError } = await db.from("wa_contacts").select("id, organization_id").eq("id", params.data.contactId).maybeSingle();
      if (contactError) {
        request.log.warn({ err: contactError.message }, "Failed to load contact for ad touches");
        return reply.status(500).send({ error: "Falha ao carregar o contato" });
      }
      const row = contact as { id: string; organization_id: string } | null;
      const membership = row ? request.user.memberships.find((m) => m.organization_id === row.organization_id) : undefined;
      if (!row || !membership) return reply.status(404).send({ error: "Contact not found" });

      const { data: convs, error: convError } = await db.from("conversations").select("assigned_to").eq("contact_id", row.id).eq("organization_id", row.organization_id).limit(200);
      if (convError) {
        request.log.warn({ err: convError.message }, "Failed to load conversations for ad touches");
        return reply.status(500).send({ error: "Falha ao carregar as conversas" });
      }
      const owners = ((convs ?? []) as Array<{ assigned_to: string | null }>).map((c) => c.assigned_to);
      if (owners.length > 0) {
        let visible = false;
        for (const owner of new Set(owners)) {
          if (await canViewLead(db, row.organization_id, membership.role, request.user.id, owner).catch(() => false)) { visible = true; break; }
        }
        if (!visible) return reply.status(403).send({ error: "Este lead pertence a outro vendedor" });
      }

      try {
        return reply.send(await getAdOriginForContact(db, row.organization_id, row.id));
      } catch (err) {
        request.log.warn({ err: (err as { message?: string })?.message }, "Failed to load ad touches");
        return reply.status(500).send({ error: "Falha ao carregar a origem do anúncio" });
      }
    },
  });
}
