import {describe,it,expect} from "vitest";
import {buildHandoffTaskRefresh} from "./handoff-task-refresh.js";
import type {Task} from "@aula-agente/shared";
const task={type:"return_customer",description:"Aguardando escolha de LiberaCred",ai_summary:null,priority:"normal",status:"pending",due_date:"2026-09-29",due_time:null,created_by_type:"ai",consolidated_pendencies:[],followup_pending_message_id:null} as unknown as Task;
const now=new Date("2026-10-02T22:19:00Z");
describe("novo encaminhamento reordena retorno vencido",()=>{
 it("troca retorno automático antigo pelo pedido atual no próximo horário de atendimento",()=>{expect(buildHandoffTaskRefresh(task,"Quer negociar compra à vista",now,8,18)).toMatchObject({due_date:"2026-10-03",due_time:"08:00:00",priority:"high",description:"Quer negociar compra à vista",ai_summary:"Quer negociar compra à vista"})});
 it("preserva urgência e usa hoje dentro do horário",()=>{expect(buildHandoffTaskRefresh({...task,priority:"urgent"},"Quer fechar",new Date("2026-10-02T15:00:00Z"),8,18)).toMatchObject({priority:"urgent",due_date:"2026-10-02",due_time:"12:00:00"})});
 it.each([{type:"awaiting_customer_cpf"},{type:"awaiting_customer_data"},{type:"scheduled_callback"},{created_by_type:"human"},{status:"rescheduled"},{status:"completed"},{due_date:"2026-10-10"},{followup_pending_message_id:"send"}])("não altera compromisso, dado aguardado ou envio pendente %j",patch=>{expect(buildHandoffTaskRefresh({...task,...patch} as Task,"Quer negociar",now,8,18)).toBeNull()});
 it("atualiza só a pendência de retorno e mantém CPF e a data dela",()=>{
 const cpf={type:"awaiting_customer_cpf",description:"Enviar CPF",priority:"urgent",due_date:"2026-10-05",due_time:null,added_at:"2026-10-01T00:00:00Z",reason:null,added_by_type:"ai",added_by_id:null} as const;
 const old={...cpf,type:"return_customer",description:task.description,priority:"normal",due_date:"2026-09-29"} as const;
 const update=buildHandoffTaskRefresh({...task,type:"awaiting_customer_cpf",consolidated_pendencies:[cpf,old]},"Quer negociar",now,8,18)!;
 expect(update.consolidated_pendencies?.[0]).toEqual(cpf);expect(update.consolidated_pendencies?.[1]).toMatchObject({description:"Quer negociar",due_date:"2026-10-03",priority:"high"});expect(update.type).toBe("awaiting_customer_cpf");
 });
 it("não altera retorno humano consolidado",()=>{expect(buildHandoffTaskRefresh({...task,consolidated_pendencies:[{...task,type:"return_customer",added_by_type:"human",added_at:"2026-10-01T00:00:00Z",added_by_id:null} as any]},"Quer negociar",now,8,18)).toBeNull()});
});

describe("human scheduling history", () => {
 it.each(["updated", "rescheduled"] as const)("preserves manually chosen expired dates after human %s", event_type => {
  expect(buildHandoffTaskRefresh({...task,due_date:"2026-09-30",due_time:"14:30:00"}, "Quer fechar", now, 8, 18, [{event_type,created_by_type:"human"}])).toBeNull();
 });
 it.each([
  {event_type:"updated",created_by_type:"ai"},
  {event_type:"rescheduled",created_by_type:"ai"},
  {event_type:"assigned",created_by_type:"human"},
 ] as const)("allows refresh with unrelated history %j", event => {
  expect(buildHandoffTaskRefresh(task, "Quer fechar", now, 8, 18, [event])).toMatchObject({due_date:"2026-10-03"});
 });
 it("preserves manual dates across consolidated pendencies", () => {
  const pendency = {type:"return_customer",description:"Retorno combinado",priority:"normal",due_date:"2026-09-30",due_time:"14:30:00",added_at:"2026-09-29T12:00:00Z",reason:null,added_by_type:"ai",added_by_id:null} as const;
  expect(buildHandoffTaskRefresh({...task,consolidated_pendencies:[pendency]}, "Quer fechar", now, 8, 18, [{event_type:"updated",created_by_type:"human"}])).toBeNull();
 });
});
