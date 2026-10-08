import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdminClient } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";

const INVITE_DAYS = 7;
const MANAGER_ROLES = ["owner", "admin"];

/** Escapes LIKE wildcards so an e-mail with `_` matches literally (case-insensitive via ilike). */
const likeLiteral = (value: string) => value.replace(/[\\%_]/g, c => `\\${c}`);

export default async function invitationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // Managers invite a person: records the invitation and returns a single-use link (no e-mail, no SMTP needed).
  // The person opens the link, chooses their own password and joins the organization.
  app.post<{ Params: { organizationId: string } }>("/organizations/:organizationId/invitations", async (request, reply) => {
    const { organizationId } = request.params;
    const membership = request.user.memberships.find(m => m.organization_id === organizationId);
    if (!membership) return reply.status(403).send({ error: "Access denied" });
    if (!MANAGER_ROLES.includes(membership.role)) return reply.status(403).send({ error: "Somente owner ou admin convidam pessoas" });

    const body = z.object({ email: z.string().trim().email(), role: z.enum(["admin", "agent"]).default("agent") }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues });
    const email = body.data.email.toLowerCase();

    const appUrl = (process.env.WEB_APP_URL ?? (request.headers.origin as string | undefined) ?? "").replace(/\/$/, "");
    if (!appUrl) return reply.status(500).send({ error: "URL do app não configurada (WEB_APP_URL)" });

    const db = getAdminClient();
    const now = new Date().toISOString();

    const pending = await db.from("organization_invitations").select("id").eq("organization_id", organizationId)
      .ilike("email", likeLiteral(email)).eq("status", "pending").gt("expires_at", now).limit(1).maybeSingle();
    if (pending.error) return reply.status(500).send({ error: "Falha ao consultar convites" });

    let invitationId: string | undefined = pending.data?.id;
    if (!invitationId) {
      const inserted = await db.from("organization_invitations").insert({
        organization_id: organizationId, email, role: body.data.role, invited_by: request.user.id, status: "pending",
        expires_at: new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString(),
      }).select("id").single();
      if (inserted.error) return reply.status(500).send({ error: "Falha ao registrar o convite" });
      invitationId = inserted.data.id;
    }

    const link = await db.auth.admin.generateLink({ type: "invite", email });
    if (link.error) {
      // The person already has a login: nothing to send; the invitation is accepted when they sign in.
      if ((link.error as { code?: string }).code === "email_exists" || /already|registered|exists/i.test(link.error.message ?? "")) {
        return { invitationId, inviteLink: null, userExists: true };
      }
      return reply.status(500).send({ error: "Falha ao gerar o link de convite" });
    }
    const tokenHash = link.data?.properties?.hashed_token;
    if (!tokenHash) return reply.status(500).send({ error: "Link de convite indisponível" });
    return {
      invitationId,
      userExists: false,
      inviteLink: `${appUrl}/accept-invite?token_hash=${encodeURIComponent(tokenHash)}&type=invite`,
    };
  });

  // The signed-in user joins every organization that has a pending, unexpired invitation for their e-mail.
  app.post("/invitations/accept", async (request, reply) => {
    const email = request.user.email?.trim().toLowerCase();
    if (!email) return reply.status(400).send({ error: "Usuário sem e-mail" });
    const db = getAdminClient();
    const now = new Date().toISOString();

    const invitations = await db.from("organization_invitations").select("id,organization_id,role")
      .ilike("email", likeLiteral(email)).eq("status", "pending").gt("expires_at", now);
    if (invitations.error) return reply.status(500).send({ error: "Falha ao consultar convites" });

    const organizationIds: string[] = [];
    for (const invitation of invitations.data ?? []) {
      const existing = await db.from("organization_members").select("id").eq("organization_id", invitation.organization_id)
        .eq("user_id", request.user.id).maybeSingle();
      if (existing.error) return reply.status(500).send({ error: "Falha ao consultar membros" });
      if (!existing.data) {
        const added = await db.from("organization_members").insert({ organization_id: invitation.organization_id, user_id: request.user.id, role: invitation.role });
        if (added.error) return reply.status(500).send({ error: "Falha ao adicionar à organização" });
      }
      const marked = await db.from("organization_invitations").update({ status: "accepted" }).eq("id", invitation.id);
      if (marked.error) return reply.status(500).send({ error: "Falha ao concluir o convite" });
      organizationIds.push(invitation.organization_id);
    }
    return { accepted: organizationIds.length, organizationIds };
  });
}
