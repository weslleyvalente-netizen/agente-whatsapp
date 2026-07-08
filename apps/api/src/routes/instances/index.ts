import type { FastifyInstance } from "fastify";
import { createInstanceSchema, updateInstanceSchema } from "@aula-agente/shared";
import { getAdminClient } from "@aula-agente/database";
import {
  getInstancesByOrganization,
  getInstanceById,
  createInstance as createInstanceRecord,
  updateInstance,
  deleteInstance as deleteInstanceRecord,
} from "@aula-agente/database";
import {
  createInstance as createEvolutionInstance,
  getInstanceStatus,
  getInstanceQrCode,
  deleteInstance as deleteEvolutionInstance,
  logoutInstance,
} from "../../services/evolution.service";
import { authMiddleware } from "../../middleware/auth";

export default async function instanceRoutes(app: FastifyInstance) {
  // All routes require auth
  app.addHook("preHandler", authMiddleware);

  // List instances for an organization
  app.get<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/instances",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId
      );
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      const instances = await getInstancesByOrganization(db, organizationId);
      return instances;
    }
  );

  // Create instance
  app.post<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/instances",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find(
        (m) => m.organization_id === organizationId && m.role !== "agent"
      );
      if (!membership) return reply.status(403).send({ error: "Admin access required" });

      const parseResult = createInstanceSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const { instance_name } = parseResult.data;
      const webhookUrl = `${process.env.EVOLUTION_API_URL ? request.protocol + '://' + request.hostname : 'http://localhost'}:${process.env.API_PORT || 3001}/webhooks/evolution`;

      // Create in Evolution API
      const evolutionResult = await createEvolutionInstance(instance_name, webhookUrl);

      // Save to database
      const db = getAdminClient();
      const instance = await createInstanceRecord(db, {
        organization_id: organizationId,
        instance_name,
        instance_id: evolutionResult.instance?.instanceName || instance_name,
        webhook_url: webhookUrl,
      });

      return reply.status(201).send(instance);
    }
  );

  // Get instance status
  app.get<{ Params: { instanceId: string } }>(
    "/instances/:instanceId/status",
    async (request, reply) => {
      const db = getAdminClient();
      const instance = await getInstanceById(db, request.params.instanceId);

      const membership = request.user.memberships.find(
        (m) => m.organization_id === instance.organization_id
      );
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const status = await getInstanceStatus(instance.instance_name);

      // Sync status to DB
      const newStatus = status?.instance?.state === "open" ? "connected" : "disconnected";
      if (newStatus !== instance.status) {
        await updateInstance(db, instance.id, {
          status: newStatus,
          phone_number: status?.instance?.phoneNumber || instance.phone_number,
        });
      }

      return { ...instance, status: newStatus, live: status };
    }
  );

  // Get QR code
  app.get<{ Params: { instanceId: string } }>(
    "/instances/:instanceId/qrcode",
    async (request, reply) => {
      const db = getAdminClient();
      const instance = await getInstanceById(db, request.params.instanceId);

      const membership = request.user.memberships.find(
        (m) => m.organization_id === instance.organization_id
      );
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const qrData = await getInstanceQrCode(instance.instance_name);
      return qrData;
    }
  );

  // Update instance (assign agent)
  app.patch<{ Params: { instanceId: string } }>(
    "/instances/:instanceId",
    async (request, reply) => {
      const db = getAdminClient();
      const instance = await getInstanceById(db, request.params.instanceId);

      const membership = request.user.memberships.find(
        (m) => m.organization_id === instance.organization_id && m.role !== "agent"
      );
      if (!membership) return reply.status(403).send({ error: "Admin access required" });

      const parseResult = updateInstanceSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const updated = await updateInstance(db, instance.id, parseResult.data);
      return updated;
    }
  );

  // Delete instance
  app.delete<{ Params: { instanceId: string } }>(
    "/instances/:instanceId",
    async (request, reply) => {
      const db = getAdminClient();
      const instance = await getInstanceById(db, request.params.instanceId);

      const membership = request.user.memberships.find(
        (m) => m.organization_id === instance.organization_id && m.role === "owner"
      );
      if (!membership) return reply.status(403).send({ error: "Owner access required" });

      // Delete from Evolution API
      try {
        await deleteEvolutionInstance(instance.instance_name);
      } catch (err) {
        request.log.warn({ err }, "Failed to delete instance from Evolution API");
      }

      await deleteInstanceRecord(db, instance.id);
      return reply.status(204).send();
    }
  );

  // Logout instance
  app.post<{ Params: { instanceId: string } }>(
    "/instances/:instanceId/logout",
    async (request, reply) => {
      const db = getAdminClient();
      const instance = await getInstanceById(db, request.params.instanceId);

      const membership = request.user.memberships.find(
        (m) => m.organization_id === instance.organization_id && m.role !== "agent"
      );
      if (!membership) return reply.status(403).send({ error: "Admin access required" });

      await logoutInstance(instance.instance_name);
      await updateInstance(db, instance.id, { status: "disconnected" });

      return { ok: true };
    }
  );
}
