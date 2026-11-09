import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PROFILE_PICTURE_BUCKET, PROFILE_PICTURE_SIGNED_URL_TTL_SECONDS } from "@aula-agente/shared";
import { getAdminClient } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { canViewLead } from "../../lib/lead-access.js";

const bodySchema = z.object({ contact_ids: z.array(z.string().uuid()).min(1).max(100) });

interface ContactRow { id: string; organization_id: string; profile_picture_path: string | null }
interface ConversationRow { contact_id: string; organization_id: string; assigned_to: string | null }

// Links temporários (signed URL) das fotos de perfil, no bucket privado. Um contato só aparece na
// resposta se tem foto, o usuário é membro da organização dele e (não há conversa ou ele pode ver
// alguma conversa do contato). Qualquer falha deixa o contato de fora, sem erro.
export default async function profilePictureUrlsRoutes(app: FastifyInstance) {
  app.post("/contacts/profile-picture-urls", {
    preHandler: [authMiddleware],
    handler: async (request, reply) => {
      const body = bodySchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: "Lista de contatos inválida (1 a 100 ids)" });
      const ids = [...new Set(body.data.contact_ids)];

      const db = getAdminClient();
      const { data: contactData, error: contactsError } = await db
        .from("wa_contacts")
        .select("id, organization_id, profile_picture_path")
        .in("id", ids);
      if (contactsError) {
        request.log.warn({ err: contactsError.message }, "Failed to load contacts for profile pictures");
        return reply.status(500).send({ error: "Falha ao carregar os contatos" });
      }
      const contacts = ((contactData ?? []) as ContactRow[]).filter((c) => {
        if (!c.profile_picture_path) return false;
        return request.user.memberships.some((mb) => mb.organization_id === c.organization_id);
      });
      if (contacts.length === 0) return reply.send({ urls: {} });

      const { data: convData, error: convError } = await db
        .from("conversations")
        .select("contact_id, organization_id, assigned_to")
        .in("contact_id", contacts.map((c) => c.id));
      if (convError) {
        request.log.warn({ err: convError.message }, "Failed to load conversations for profile pictures");
        return reply.status(500).send({ error: "Falha ao carregar as conversas" });
      }
      const convsByContact = new Map<string, ConversationRow[]>();
      for (const conv of (convData ?? []) as ConversationRow[]) {
        const list = convsByContact.get(conv.contact_id) ?? [];
        list.push(conv);
        convsByContact.set(conv.contact_id, list);
      }

      // Memoiza por (organização, dono): evita repetir a consulta de organização/vendedores.
      const viewCache = new Map<string, Promise<boolean>>();
      const canView = (organizationId: string, role: string, owner: string | null) => {
        const key = `${organizationId}|${owner ?? ""}`;
        let cached = viewCache.get(key);
        if (!cached) {
          cached = canViewLead(db, organizationId, role, request.user.id, owner).catch(() => false);
          viewCache.set(key, cached);
        }
        return cached;
      };

      const allowed: ContactRow[] = [];
      for (const contact of contacts) {
        const role = request.user.memberships.find((mb) => mb.organization_id === contact.organization_id)!.role;
        const convs = convsByContact.get(contact.id) ?? [];
        let ok = convs.length === 0;
        for (const conv of convs) {
          if (await canView(contact.organization_id, role, conv.assigned_to)) { ok = true; break; }
        }
        if (ok) allowed.push(contact);
      }
      if (allowed.length === 0) return reply.send({ urls: {} });

      const urls: Record<string, string> = {};
      const paths = [...new Set(allowed.map((c) => c.profile_picture_path as string))];
      const { data: signed, error: signError } = await db.storage
        .from(PROFILE_PICTURE_BUCKET)
        .createSignedUrls(paths, PROFILE_PICTURE_SIGNED_URL_TTL_SECONDS);
      if (signError || !signed) {
        request.log.warn({ err: signError?.message }, "Failed to sign profile picture urls");
        return reply.send({ urls });
      }
      const byPath = new Map<string, string>();
      for (const item of signed) if (item.path && item.signedUrl && !item.error) byPath.set(item.path, item.signedUrl);
      for (const contact of allowed) {
        const url = byPath.get(contact.profile_picture_path as string);
        if (url) urls[contact.id] = url;
      }
      return reply.send({ urls });
    },
  });
}
