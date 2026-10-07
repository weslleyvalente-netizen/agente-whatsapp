import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequestHumanTool } from "./request-human.js";

const updateConversation = vi.fn();
const createHandoffEvent = vi.fn();
const getOrganizationById = vi.fn();
const getOpenTasksByConversation = vi.fn();
const updateTask = vi.fn();
const getTaskEvents = vi.fn();
const addTaskEvent = vi.fn();
const getOpenOpportunitiesByContact = vi.fn();
const createTaskWithDedup = vi.fn();
const distributeLeadForHandoff = vi.fn();

vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  updateConversation: (...args: unknown[]) => updateConversation(...args),
  createHandoffEvent: (...args: unknown[]) => createHandoffEvent(...args),
  getOrganizationById: (...args: unknown[]) => getOrganizationById(...args),
  getOpenTasksByConversation: (...args: unknown[]) => getOpenTasksByConversation(...args),
  getTaskEvents: (...args: unknown[]) => getTaskEvents(...args),
  updateTask: (...args: unknown[]) => updateTask(...args),
  addTaskEvent: (...args: unknown[]) => addTaskEvent(...args),
  getOpenOpportunitiesByContact: (...args: unknown[]) => getOpenOpportunitiesByContact(...args),
  createTaskWithDedup: (...args: unknown[]) => createTaskWithDedup(...args),
  distributeLeadForHandoff: (...args: unknown[]) => distributeLeadForHandoff(...args),
}));

const addToSendQueue = vi.fn();
vi.mock("@aula-agente/queue", () => ({
  getSendMessageQueue: () => ({ add: (...args: unknown[]) => addToSendQueue(...args) }),
}));

const context = {
  contactId: "contact-1",
  conversationId: "conv-1",
  organizationId: "org-1",
  instanceId: "instance-1",
  phone: "5511999990000",
  businessHoursStartHour: 8,
  businessHoursEndHour: 18,
};

const baseInput = {
  motivo: "cliente_pediu" as const,
  resumo: "Cliente quer negociar desconto na Factor 150",
  urgencia: "normal" as const,
};

const orgNoDefaults = { id: "org-1", settings: {} };

beforeEach(() => {
  vi.resetAllMocks();
  getOrganizationById.mockResolvedValue(orgNoDefaults);
  getOpenTasksByConversation.mockResolvedValue([]);
  getTaskEvents.mockResolvedValue([]);
  createHandoffEvent.mockResolvedValue({ id: "handoff-1" });
  getOpenOpportunitiesByContact.mockResolvedValue([]);
  createTaskWithDedup.mockResolvedValue({ task: { id: "task-1", title: "Outro" }, wasUpdated: false });
  distributeLeadForHandoff.mockResolvedValue(null);
});

describe("createRequestHumanTool lead distribution", () => {
  it("chama a distribuição com o id do handoff recém-criado", async () => {
    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(distributeLeadForHandoff).toHaveBeenCalledWith({}, {
      organizationId: "org-1",
      conversationId: "conv-1",
      handoffEventId: "handoff-1",
    });
  });

  it("mantém o handoff quando a distribuição falha", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    distributeLeadForHandoff.mockRejectedValue(new Error("rpc down"));

    const toolDef = createRequestHumanTool(context);
    const result = await toolDef.execute!(baseInput, {} as never);

    expect(result).toContain("Handoff registrado");
    expect(updateConversation).toHaveBeenCalledWith({}, "conv-1", expect.objectContaining({ is_human_takeover: true }));
  });
});

describe("createRequestHumanTool", () => {
  it("activates is_human_takeover on the conversation", async () => {
    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(updateConversation).toHaveBeenCalledWith(
      {},
      "conv-1",
      expect.objectContaining({ is_human_takeover: true })
    );
  });

  it("records a handoff_events row with trigger_type=request_human and the tool's own fields", async () => {
    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(createHandoffEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        organization_id: "org-1",
        conversation_id: "conv-1",
        trigger_type: "request_human",
        motivo: "cliente_pediu",
        resumo: baseInput.resumo,
        urgencia: "normal",
        criado_por: "ia",
      })
    );
  });

  it("assigns the conversation to the organization's default handoff assignee when configured", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { default_handoff_assignee_id: "user-42" } });

    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(updateConversation).toHaveBeenCalledWith(
      {},
      "conv-1",
      expect.objectContaining({ assigned_to: "user-42" })
    );
  });

  it("does not set assigned_to when no default handoff assignee is configured", async () => {
    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    const call = updateConversation.mock.calls[0][2];
    expect(call).not.toHaveProperty("assigned_to");
  });

  it("reassigns open tasks for the conversation to the default assignee", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { default_handoff_assignee_id: "user-42" } });
    getOpenTasksByConversation.mockResolvedValue([{ id: "task-1", organization_id: "org-1", status: "pending", updated_at: "2026-10-02T12:00:00Z" }]);
    updateTask.mockResolvedValue({ id: "task-1" });

    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(updateTask).toHaveBeenCalledWith(
      {},
      "task-1",
      expect.objectContaining({ assignee_type: "human", assignee_id: "user-42", status: "in_progress" }),
      "2026-10-02T12:00:00Z"
    );
  });

  it("tells the model to mention the current attendant is continuing, during business hours", async () => {
    const toolDef = createRequestHumanTool(context);
    const result = await toolDef.execute!(baseInput, {} as never);

    expect(result).toContain("consultor");
  });

  it("still returns successfully and logs the handoff even if the internal notification isn't configured", async () => {
    const toolDef = createRequestHumanTool(context);
    const result = await toolDef.execute!(baseInput, {} as never);

    expect(addToSendQueue).not.toHaveBeenCalled();
    expect(result).not.toContain("Não foi possível");
  });

  it("enqueues an internal WhatsApp notification when the org configured a notification phone", async () => {
    getOrganizationById.mockResolvedValue({
      id: "org-1",
      settings: { handoff_notification_phone: "5511888880000" },
    });

    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(addToSendQueue).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ phone: "5511888880000", instanceId: "instance-1" })
    );
  });

  it("does not fail the whole tool call when creating the handoff event throws", async () => {
    createHandoffEvent.mockRejectedValue(new Error("db blip"));

    const toolDef = createRequestHumanTool(context);
    const result = await toolDef.execute!(baseInput, {} as never);

    expect(result).toContain("Não foi possível");
  });

  // Regression for the 2026-09-28 production incident: org cf01d00d had
  // neither default_handoff_assignee_id nor handoff_notification_phone
  // configured, so the handoff was recorded but nobody — and nothing —
  // ever surfaced it. requestHuman now falls back to creating a task (same
  // opportunity-linking as createTask) whenever neither route exists, so
  // the handoff is at least visible somewhere in the panel.
  describe("fallback task when no assignee/phone is configured", () => {
    it("creates a fallback task when neither a default assignee nor a notification phone is configured", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });

      const toolDef = createRequestHumanTool(context);
      await toolDef.execute!(baseInput, {} as never);

      expect(createTaskWithDedup).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ organization_id: "org-1", contact_id: "contact-1", conversation_id: "conv-1" })
      );
    });

    it("does not create a fallback task when a default assignee is configured", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: { default_handoff_assignee_id: "user-42" } });

      const toolDef = createRequestHumanTool(context);
      await toolDef.execute!(baseInput, {} as never);

      expect(createTaskWithDedup).not.toHaveBeenCalled();
    });

    it("does not create a fallback task when a notification phone is configured", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: { handoff_notification_phone: "5511888880000" } });

      const toolDef = createRequestHumanTool(context);
      await toolDef.execute!(baseInput, {} as never);

      expect(createTaskWithDedup).not.toHaveBeenCalled();
    });

    it("links the fallback task to the contact's sole open opportunity, same as createTask", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
      getOpenOpportunitiesByContact.mockResolvedValue([{ id: "opp-1" }]);

      const toolDef = createRequestHumanTool(context);
      await toolDef.execute!(baseInput, {} as never);

      expect(createTaskWithDedup).toHaveBeenCalledWith({}, expect.objectContaining({ opportunity_id: "opp-1" }));
    });

    it("leaves opportunity_id null when the contact has zero or several open opportunities", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
      getOpenOpportunitiesByContact.mockResolvedValue([{ id: "opp-1" }, { id: "opp-2" }]);

      const toolDef = createRequestHumanTool(context);
      await toolDef.execute!(baseInput, {} as never);

      expect(createTaskWithDedup).toHaveBeenCalledWith({}, expect.objectContaining({ opportunity_id: null }));
    });

    it("still succeeds the handoff even if the fallback task creation throws", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
      createTaskWithDedup.mockRejectedValue(new Error("db blip"));

      const toolDef = createRequestHumanTool(context);
      const result = await toolDef.execute!(baseInput, {} as never);

      expect(result).not.toContain("Não foi possível");
      expect(createHandoffEvent).toHaveBeenCalled();
    });
  });
});

it("refreshes expired AI return reminders on a new handoff, with an event preserving previous context",async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-02T22:19:00Z"));
 getOrganizationById.mockResolvedValue({id:"org-1",settings:{sales_qualified_handoff_task_enabled:true}});
 getOpenTasksByConversation.mockResolvedValue([{id:"old",organization_id:"org-1",type:"return_customer",description:"Plano antigo",status:"pending",priority:"normal",due_date:"2026-09-29",due_time:null,created_by_type:"ai",updated_at:"old-version",consolidated_pendencies:[]}]);
 await createRequestHumanTool(context).execute!(baseInput,{} as never);
 expect(updateTask).toHaveBeenCalledWith({},"old",expect.objectContaining({description:baseInput.resumo,due_date:"2026-10-03",priority:"high"}),"old-version");
 expect(addTaskEvent).toHaveBeenCalledWith({},expect.objectContaining({event_type:"rescheduled",note:expect.stringContaining("Plano antigo")}));vi.useRealTimers();
});
it("keeps frozen opportunity reminders unchanged",async()=>{
 getOrganizationById.mockResolvedValue({id:"org-1",settings:{sales_qualified_handoff_task_enabled:true}});
 getOpenOpportunitiesByContact.mockResolvedValue([{id:"frozen",frozen_until:"2026-10-10"}]);
 getOpenTasksByConversation.mockResolvedValue([{id:"old",organization_id:"org-1",opportunity_id:"frozen",type:"return_customer",description:"Plano antigo",status:"pending",priority:"normal",due_date:"2026-09-29",created_by_type:"ai",consolidated_pendencies:[]}]);
 await createRequestHumanTool(context).execute!(baseInput,{} as never);
 expect(updateTask.mock.calls[0][2]).not.toHaveProperty("due_date");
});

afterEach(() => vi.useRealTimers());

describe("handoff refresh guards", () => {
 const oldTask = {id:"old",organization_id:"org-1",opportunity_id:"opp-1",type:"return_customer",description:"Data escolhida",status:"pending",priority:"normal",due_date:"2026-09-30",due_time:"14:30:00",created_by_type:"ai",updated_at:"snapshot",consolidated_pendencies:[]};
 beforeEach(() => {
  vi.useFakeTimers();
  // São Paulo is still October 2 while UTC is already October 3.
  vi.setSystemTime(new Date("2026-10-03T01:00:00Z"));
  getOrganizationById.mockResolvedValue({id:"org-1",settings:{sales_qualified_handoff_task_enabled:true,default_handoff_assignee_id:"user-42"}});
  getOpenTasksByConversation.mockResolvedValue([oldTask]);
 });
 const expectPreserved = () => {
  expect(updateTask).toHaveBeenCalledWith({},"old",{assignee_type:"human",assignee_id:"user-42",status:"in_progress"},"snapshot");
  expect(addTaskEvent.mock.calls.some(([,event]) => event.event_type === "rescheduled")).toBe(false);
 };
 it.each(["updated","rescheduled"])("preserves manual date with human %s history", async event_type => {
  getTaskEvents.mockResolvedValue([{event_type,created_by_type:"human"}]);
  await createRequestHumanTool(context).execute!(baseInput,{} as never);
  expect(getTaskEvents).toHaveBeenCalledWith({},"old");
  expectPreserved();
 });
 it.each([
  {event_type:"updated",status:"completed"},
  {event_type:"rescheduled",status:"rescheduled"},
  {event_type:"updated",status:"cancelled"},
 ])("does not reopen or reassign after concurrent human $event_type ($status)", async ({event_type,status}) => {
  const {updateTask: realUpdateTask} = await vi.importActual<typeof import("@aula-agente/database")>("@aula-agente/database");
  const snapshot = {...oldTask,updated_at:"2026-10-02T12:00:00Z"};
  const row = {...snapshot,assignee_type:"human",assignee_id:"original-human"};
  getOpenTasksByConversation.mockResolvedValue([snapshot]);
  getTaskEvents.mockImplementation(async () => {
   // The human commits after open-task discovery, before history is read.
   Object.assign(row,{status,due_date:"2026-10-10",due_time:"15:30:00",updated_at:"2026-10-03T00:59:00Z"});
   return [{event_type,created_by_type:"human",created_at:"2026-10-03T00:59:00Z"}];
  });
  const db = {from: () => {
   const filters: Record<string,unknown> = {};
   let patch: Record<string,unknown> = {};
   const query = {
    update(value: Record<string,unknown>) {patch=value;return this;},
    eq(key: string,value: unknown) {filters[key]=value;return this;},
    select() {return this;},
    async single() {
     if(Object.entries(filters).some(([key,value]) => (row as Record<string,unknown>)[key] !== value)) {
      return {data:null,error:{code:"PGRST116"}};
     }
     Object.assign(row,patch);
     return {data:row,error:null};
    },
   };
   return query;
  }};
  updateTask.mockImplementation((_db,id,patch,version) => realUpdateTask(db as never,id,patch,version));
  const log = vi.spyOn(console,"error").mockImplementation(() => {});
  try {
   await createRequestHumanTool(context).execute!(baseInput,{} as never);
   expect(row).toMatchObject({status,assignee_id:"original-human",due_date:"2026-10-10",due_time:"15:30:00",updated_at:"2026-10-03T00:59:00Z"});
   expect(updateTask).toHaveBeenCalledWith({},"old",expect.any(Object),"2026-10-02T12:00:00Z");
   expect(addTaskEvent).not.toHaveBeenCalled();
   expect(log).toHaveBeenCalledWith("requestHuman tool: failed to reassign open tasks:",expect.objectContaining({message:"A tarefa mudou. Atualize e tente novamente."}));
  } finally {
   log.mockRestore();
  }
 });
 it.each(["documentos","reclamacao","fora_do_escopo","ia_sem_resposta"] as const)("does not refresh for noncommercial reason %s", async motivo => {
  await createRequestHumanTool(context).execute!({...baseInput,motivo},{} as never);
  expectPreserved();
 });
 it.each(["cliente_pediu","proposta_pronta","negociacao_valor"] as const)("refreshes for commercial reason %s", async motivo => {
  await createRequestHumanTool(context).execute!({...baseInput,motivo},{} as never);
  expect(updateTask).toHaveBeenCalledWith({},"old",expect.objectContaining({due_date:"2026-10-03",description:baseInput.resumo}),"snapshot");
 });
 it.each(["2026-10-01","2026-10-02"])("refreshes after freeze expires on %s", async frozen_until => {
  getOpenOpportunitiesByContact.mockResolvedValue([{id:"opp-1",frozen_until}]);
  await createRequestHumanTool(context).execute!(baseInput,{} as never);
  expect(updateTask.mock.calls[0][2]).toHaveProperty("due_date","2026-10-03");
 });
 it("preserves an active freeze based on the local date", async () => {
  getOpenOpportunitiesByContact.mockResolvedValue([{id:"opp-1",frozen_until:"2026-10-03"}]);
  await createRequestHumanTool(context).execute!(baseInput,{} as never);
  expectPreserved();
 });
 it("does not block a task linked to another opportunity", async () => {
  getOpenOpportunitiesByContact.mockResolvedValue([{id:"other",frozen_until:"2026-10-10"}]);
  await createRequestHumanTool(context).execute!(baseInput,{} as never);
  expect(updateTask.mock.calls[0][2]).toHaveProperty("due_date","2026-10-03");
 });
});
