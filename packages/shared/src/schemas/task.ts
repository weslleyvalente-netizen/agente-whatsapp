import { z } from "zod";
import { TASK_TYPES, TASK_PRIORITIES } from "../constants.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data deve estar no formato YYYY-MM-DD");
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, "Horário deve estar no formato HH:MM");

const assigneeRefineMessage = {
  message: "assignee_id deve ser definido se e somente se assignee_type for 'human'",
  path: ["assignee_id"],
};

export const createTaskSchema = z
  .object({
    contact_id: z.string().uuid(),
    conversation_id: z.string().uuid().nullable().optional(),
    assignee_type: z.enum(["human", "ai"]).nullable().optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    type: z.enum(TASK_TYPES),
    description: z.string().max(5000).default(""),
    reason: z.string().max(2000).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).default("normal"),
    due_date: dateSchema,
    due_time: timeSchema.nullable().optional(),
  })
  .refine(
    (data) => (data.assignee_type === "human" ? !!data.assignee_id : !data.assignee_id),
    assigneeRefineMessage
  );

export const updateTaskSchema = z
  .object({
    type: z.enum(TASK_TYPES).optional(),
    description: z.string().max(5000).optional(),
    reason: z.string().max(2000).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    due_date: dateSchema.optional(),
    due_time: timeSchema.nullable().optional(),
    assignee_type: z.enum(["human", "ai"]).nullable().optional(),
    assignee_id: z.string().uuid().nullable().optional(),
  })
  .refine(
    (data) => (data.assignee_type === "human" ? !!data.assignee_id : !data.assignee_id),
    assigneeRefineMessage
  );

export const rescheduleTaskSchema = z.object({
  due_date: dateSchema,
  due_time: timeSchema.nullable().optional(),
});

export const cancelTaskSchema = z.object({
  note: z.string().max(2000).nullable().optional(),
});
