import type { FastifyInstance } from "fastify";
import { createTaskSchema, updateTaskSchema, rescheduleTaskSchema, cancelTaskSchema } from "@aula-agente/shared";
import { getAdminClient, createTaskWithDedup, getTaskById } from "@aula-agente/database";
import {
  completeTask,
  cancelTask,
  rescheduleTask,
  updateTaskFields,
  getOrganizationMembersDisplay,
} from "../../services/task.service.js";
import { authMiddleware } from "../../middleware/auth.js";

export default async function taskRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/members/display",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      const members = await getOrganizationMembersDisplay(db, organizationId);
      return members;
    }
  );

  app.post<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/tasks",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const parseResult = createTaskSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();

      const { data: contact } = await db
        .from("wa_contacts")
        .select("id")
        .eq("id", parseResult.data.contact_id)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!contact) {
        return reply.status(403).send({ error: "Contact does not belong to this organization" });
      }

      if (parseResult.data.conversation_id) {
        const { data: conv } = await db
          .from("conversations")
          .select("id")
          .eq("id", parseResult.data.conversation_id)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!conv) {
          return reply.status(403).send({ error: "Conversation does not belong to this organization" });
        }
      }

      const { task, wasUpdated } = await createTaskWithDedup(db, {
        organization_id: organizationId,
        contact_id: parseResult.data.contact_id,
        conversation_id: parseResult.data.conversation_id ?? null,
        type: parseResult.data.type,
        description: parseResult.data.description,
        reason: parseResult.data.reason ?? null,
        priority: parseResult.data.priority,
        due_date: parseResult.data.due_date,
        due_time: parseResult.data.due_time ?? null,
        created_by_type: "human",
        created_by_id: request.user.id,
        assignee_type: parseResult.data.assignee_type ?? null,
        assignee_id: parseResult.data.assignee_id ?? null,
      });

      return reply.status(201).send({ task, wasUpdated });
    }
  );

  app.patch<{ Params: { taskId: string } }>("/tasks/:taskId", async (request, reply) => {
    const parseResult = updateTaskSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find(
      (m) => m.organization_id === existing.organization_id
    );
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const task = await updateTaskFields(db, request.params.taskId, parseResult.data, request.user.id);
    return task;
  });

  app.post<{ Params: { taskId: string } }>("/tasks/:taskId/complete", async (request, reply) => {
    const db = getAdminClient();
    const existing = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find(
      (m) => m.organization_id === existing.organization_id
    );
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return completeTask(db, request.params.taskId, { type: "human", id: request.user.id });
  });

  app.post<{ Params: { taskId: string } }>("/tasks/:taskId/cancel", async (request, reply) => {
    const parseResult = cancelTaskSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find(
      (m) => m.organization_id === existing.organization_id
    );
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const task = await cancelTask(
      db,
      request.params.taskId,
      { type: "human", id: request.user.id },
      parseResult.data.note ?? null
    );
    return task;
  });

  app.post<{ Params: { taskId: string } }>("/tasks/:taskId/reschedule", async (request, reply) => {
    const parseResult = rescheduleTaskSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getTaskById(db, request.params.taskId);
    const membership = request.user.memberships.find(
      (m) => m.organization_id === existing.organization_id
    );
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const task = await rescheduleTask(
      db,
      request.params.taskId,
      { type: "human", id: request.user.id },
      parseResult.data.due_date,
      parseResult.data.due_time ?? null
    );
    return task;
  });
}
