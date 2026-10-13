"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, MessageSquare, MessageCircle, Phone, Snowflake, X } from "lucide-react";
import { displayText, distinctDisplayTexts } from "@/lib/display-text";
import { formatPhone } from "@/lib/utils";
import { useOrganization } from "@/providers/organization-provider";
import { ChatPanel } from "@/components/inbox/chat-panel";
import { TaskDetailPanel } from "@/components/tasks/task-detail-panel";
import { apiFetch } from "@/lib/api";
import { resolveOpportunityEditValues, CALL_OUTCOME_LABELS, CALL_STRATEGY_LABELS, FUNNEL_STAGES, FUNNEL_STAGE_LABELS, OPERATIONS, buildWhatsAppUrl, OPERATION_LABELS, LEAD_ORIGIN_LABELS, TASK_TYPE_LABELS } from "@aula-agente/shared";
import type { Opportunity, OpportunityEvent, Task, LeadOriginSource, Operation } from "@aula-agente/shared";
import type { OpportunityWithContact } from "./opportunity-kanban";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { OpportunityFreezeDialog } from "./opportunity-freeze-dialog";
import { OpportunityEditDialog } from "./opportunity-edit-dialog";
import { StageChangeDialog } from "./stage-change-dialog";
import { CallLogDialog, type CallLogEntry } from "./call-log-dialog";
import { AssignmentHistory } from "../lead-distribution/assignment-history";
interface Details {
 opportunity: Opportunity; customer: { name: string | null; phone: string };
 conversation: { id: string } | null;
 qualification: { cpf: string | null; has_cpf: boolean; summary?: string | null; product_interest?: string | null; product_model?: string | null; city?: string | null; birth_date?: string | null; has_driver_license?: boolean | null; driver_license_category?: string | null; target_installment_amount?: number | null; down_payment_amount?: number | null; commercial_notes?: string | null } | null;
 origin: { source: LeadOriginSource; evidence?: string } | null;
 tasks: Task[]; events: OpportunityEvent[];
}
const money = (value: number | null | undefined) => value == null ? "Não informado" : Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const eventLabels: Record<string, string> = { created: "Oportunidade criada", stage_changed: "Etapa alterada", operation_changed: "Operação alterada", won: "Negócio ganho", lost: "Negócio perdido", owner_changed: "Responsável alterado", next_action_updated: "Próxima ação atualizada", waiting_on_changed: "Pendência atualizada", reopened: "Reaberta" };
function Field({ label, value }: { label: string; value?: string | number | null }) {
 if (value == null || value === "" || value === "Não informado") return null;
 return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{typeof value === "string" ? displayText(value) : value}</dd></div>;
}
export function OpportunityDetailDialog({ opportunity, onClose, onChanged }: { opportunity: OpportunityWithContact; onClose: () => void; onChanged: () => void }) {
 const { currentOrg } = useOrganization();
 const workspaceEnabled = currentOrg?.settings.sales_workspace_enabled === true || currentOrg?.settings.sales_action_queue_enabled === true;
 const [selectedTask, setSelectedTask] = useState<Task | null>(null);
 const [chatOpen, setChatOpen] = useState(true);
 const [details, setDetails] = useState<Details | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [originEditing, setOriginEditing] = useState(false);
 const [originSource, setOriginSource] = useState<LeadOriginSource>("site_wix");
 const [moving, setMoving] = useState(false);
 const [targetOperation, setTargetOperation] = useState<Operation>(opportunity.operation);
 const [moveReason, setMoveReason] = useState("");
 const [freezing,setFreezing]=useState(false);
 const [callOpen, setCallOpen] = useState(false);
 const [callLogs, setCallLogs] = useState<CallLogEntry[]>([]);
 const [editing, setEditing] = useState(false);
 const [stage, setStage] = useState<string | null>(null);
 const [closing, setClosing] = useState<"won" | "lost" | null>(null);
 const [evidence, setEvidence] = useState(""); const [reason, setReason] = useState("sem_resposta"); const [saving, setSaving] = useState(false);
 const load = useCallback(async (reveal = false) => { try { setError(null); setDetails(await apiFetch(`/opportunities/${opportunity.id}/details${reveal ? "?revealCpf=true" : ""}`)); } catch (err) { setError((err as Error).message); } }, [opportunity.id]);
 const loadCalls = useCallback(async () => { try { const r = await apiFetch(`/opportunities/${opportunity.id}/call-logs`); setCallLogs(r.logs ?? []); } catch { setCallLogs([]); } }, [opportunity.id]);
 useEffect(() => { load(); loadCalls(); }, [load, loadCalls]);
 const o = details?.opportunity ?? opportunity; const q = details?.qualification;
 const commercial=resolveOpportunityEditValues({...o},q as Record<string,unknown>|null) as unknown as Opportunity;
 async function changeStage(e: string) { await apiFetch(`/opportunities/${o.id}/stage`, { method: "POST", body: JSON.stringify({ stage, evidence: e }) }); setStage(null); await load(); onChanged(); }
 async function moveOperation() {
  if (targetOperation === o.operation || !moveReason.trim()) return;
  setSaving(true); setError(null);
  try { await apiFetch(`/opportunities/${o.id}/operation`, { method: "POST", body: JSON.stringify({ operation: targetOperation, evidence: moveReason.trim() }) }); setMoving(false); setMoveReason(""); await load(); onChanged(); }
  catch (err) { setError((err as Error).message); } finally { setSaving(false); }
 }
 const whatsappUrl = buildWhatsAppUrl(details?.customer.phone ?? opportunity.wa_contacts?.phone);
 async function saveOrigin() { setSaving(true); try { await apiFetch(`/opportunities/${o.id}/origin`, { method: "PATCH", body: JSON.stringify({ source: originSource }) }); setOriginEditing(false); await load(); } catch (err) { setError((err as Error).message); } finally { setSaving(false); } }
 async function closeDeal() {
  if (!closing || !evidence.trim()) { setError("Descreva o que confirma essa decisão."); return; }
  setSaving(true); try { await apiFetch(`/opportunities/${o.id}/${closing}`, { method: "POST", body: JSON.stringify({ evidence: evidence.trim(), ...(closing === "lost" ? { lost_reason: reason } : {}) }) }); setClosing(null); setEvidence(""); await load(); onChanged(); } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
 }
 return <>
  <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
   <DialogContent className="w-[95vw] sm:max-w-7xl max-h-[90vh] overflow-y-auto">
    <DialogHeader><DialogTitle>{details?.customer.name || opportunity.wa_contacts?.name || "Detalhes do lead"}</DialogTitle><p className="text-sm text-muted-foreground">{OPERATION_LABELS[o.operation]} · {formatPhone(details?.customer.phone || opportunity.wa_contacts?.phone)} · {o.status === "open" ? "Em andamento" : o.status === "won" ? "Ganho" : "Perdido"}</p></DialogHeader>
    {workspaceEnabled && opportunity.sales_state?.humanPending && <section className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"><strong>Encaminhado pela IA</strong><p className="mt-1 line-clamp-2">{displayText(opportunity.sales_state.handoffSummary) || "Cliente aguardando atendimento humano."}</p>{opportunity.sales_state.handedAt && <p className="mt-1 text-xs text-muted-foreground">Aguardando desde {new Date(opportunity.sales_state.handedAt).toLocaleString("pt-BR")}</p>}</section>}
    {workspaceEnabled && o.status === "open" && !o.frozen_until && opportunity.sales_state?.responseOverdue && <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"><strong>Resposta da IA pendente</strong><p className="mt-1">A última mensagem é do cliente e aguarda resposta da IA há pelo menos 5 minutos. Confira a conversa antes de responder para evitar duplicidade.</p></section>}
    {o.frozen_until && <p className="rounded border p-3 text-sm">{o.frozen_until > new Date().toLocaleDateString("en-CA",{timeZone:"America/Sao_Paulo"}) ? "Congelado até" : "Retorno combinado para"} {new Date(`${o.frozen_until}T12:00:00`).toLocaleDateString("pt-BR")} — {o.freeze_reason}. Cadências automáticas pausadas.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!details && <Button variant="outline" onClick={() => load()}>Carregar detalhes</Button>}
    <div className="flex flex-wrap gap-2">{FUNNEL_STAGES[o.operation].map(s => <Button key={s} size="sm" variant={s === o.stage ? "default" : "outline"} disabled={o.status !== "open" || s === o.stage} onClick={() => setStage(s)}>{FUNNEL_STAGE_LABELS[s] ?? s}</Button>)}</div>
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
     <div role="group" aria-label="Atendimento" className="space-y-1">
      <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">Atendimento</p>
      <div className="flex flex-wrap gap-2">
       {details?.conversation && <Link className={buttonVariants({ variant: "default" })} href={`/inbox?id=${details.conversation.id}`}><MessageSquare aria-hidden />Abrir conversa</Link>}
       {whatsappUrl && <a className={buttonVariants({ variant: "default" })} href={whatsappUrl} target="_blank" rel="noopener noreferrer"><MessageCircle aria-hidden />Abrir no WhatsApp</a>}
       <Button onClick={() => setCallOpen(true)}><Phone aria-hidden />Registrar ligação</Button>
      </div>
     </div>
     {o.status === "open" && <div role="group" aria-label="Avançar negócio" className="space-y-1 rounded-lg border p-2">
      <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">Avançar negócio</p>
      <div className="flex flex-wrap gap-2">
       <Button size="lg" className="h-9 bg-green-600 px-4 text-white hover:bg-green-700 focus-visible:ring-green-600/50 dark:bg-green-600 dark:hover:bg-green-500" onClick={() => { setError(null); setClosing("won"); }}><Check aria-hidden />Marcar como ganho</Button>
       <Button size="lg" className="h-9 bg-sky-600 px-4 text-white hover:bg-sky-700 focus-visible:ring-sky-600/50 dark:bg-sky-600 dark:hover:bg-sky-500" onClick={() => setFreezing(true)}><Snowflake aria-hidden />{o.frozen_until ? "Reagendar / descongelar" : "Congelar e marcar retorno"}</Button>
       <Button size="lg" className="h-9 bg-red-600 px-4 text-white hover:bg-red-700 focus-visible:ring-red-600/50 dark:bg-red-600 dark:hover:bg-red-500" onClick={() => { setError(null); setClosing("lost"); }}><X aria-hidden />Marcar como perdido</Button>
      </div>
     </div>}
     <div role="group" aria-label="Gerenciar" className="space-y-1">
      <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">Gerenciar</p>
      <div className="flex flex-wrap gap-1">
       <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Editar dados</Button>
       <Button size="sm" variant="ghost" disabled={saving} onClick={() => { setTargetOperation(o.operation); setMoveReason(""); setMoving(!moving); }}>Mover para outro funil</Button>
      </div>
     </div>
    </div>
    {moving && <section className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">Mover para outro funil</h3><label className="block text-sm">Funil de destino<select aria-label="Funil de destino" className="mt-1 block w-full rounded border bg-background p-2" value={targetOperation} disabled={saving} onChange={e => setTargetOperation(e.target.value as Operation)}>{OPERATIONS.map(op => <option key={op} value={op}>{OPERATION_LABELS[op]}</option>)}</select></label><p className="text-sm text-muted-foreground">O negócio entra em {FUNNEL_STAGE_LABELS[FUNNEL_STAGES[targetOperation][0]]}. O histórico e a situação atual são preservados.</p><label className="block text-sm">Motivo da mudança<Textarea value={moveReason} disabled={saving} onChange={e => setMoveReason(e.target.value)} placeholder="Ex.: veio pela bike e decidiu aderir ao consórcio" /></label><div className="flex gap-2"><Button disabled={saving || targetOperation === o.operation || !moveReason.trim()} onClick={moveOperation}>{saving ? "Salvando..." : "Confirmar mudança"}</Button><Button variant="outline" disabled={saving} onClick={() => setMoving(false)}>Cancelar</Button></div></section>}
    {closing && <section className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">Confirmar negócio {closing === "won" ? "ganho" : "perdido"}</h3>{closing === "lost" && <label className="block text-sm">Motivo<select className="mt-1 block w-full rounded border bg-background p-2" value={reason} onChange={e => setReason(e.target.value)}><option value="sem_resposta">Sem resposta</option><option value="preco">Preço</option><option value="sem_interesse">Sem interesse</option><option value="comprou_outro">Comprou em outro lugar</option><option value="outro">Outro (descreva abaixo)</option></select></label>}<label className="block text-sm">O que confirma essa decisão?<Textarea value={evidence} onChange={e => setEvidence(e.target.value)} /></label><div className="flex gap-2"><Button disabled={saving || !evidence.trim()} onClick={closeDeal}>{saving ? "Salvando..." : "Confirmar"}</Button><Button variant="outline" disabled={saving} onClick={() => setClosing(null)}>Cancelar</Button></div></section>}
    <div className={workspaceEnabled && details?.conversation && chatOpen ? "grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : ""}>
    <div className="grid content-start gap-4">
     <div className="space-y-4"><section className="rounded-lg border p-4"><h3 className="mb-3 font-medium">Interesse e condições</h3><dl className="grid grid-cols-2 gap-4"><Field label="Bem desejado" value={o.product_model ?? q?.product_model ?? q?.product_interest ?? o.product}/><Field label="Parcela confortável" value={money(commercial.target_installment_amount)}/><Field label="Entrada" value={money(commercial.down_payment_amount)}/><Field label="Prazo (meses)" value={o.term_months}/><Field label="Valor do bem" value={money(o.sale_amount)}/><Field label="Crédito" value={money(o.credit_amount)}/><Field label="Lance" value={money(o.bid_amount)}/><Field label="Urgência" value={o.urgency}/><Field label="Finalidade" value={o.usage_purpose}/><Field label="Objeção / restrição" value={o.main_objection}/></dl></section>
     <section className="rounded-lg border border-primary/20 bg-primary/5 p-4" aria-label="Dados para financiamento">
 <div className="mb-3 flex items-center justify-between gap-2"><h3 className="font-medium">Dados para financiamento</h3><Button size="sm" variant="outline" onClick={() => setEditing(true)}>Editar dados</Button></div>
 <dl className="grid grid-cols-2 gap-3">
  <Field label="CPF" value={q?.cpf || (q?.has_cpf ? "Coletado · oculto" : "Falta coletar")}/>
  <Field label="Data de nascimento" value={q?.birth_date ? new Date(`${q.birth_date.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR") : "Falta coletar"}/>
  <Field label="Tem CNH?" value={q?.has_driver_license == null ? "Falta coletar" : q.has_driver_license ? "Sim" : "Não"}/>
  <Field label="Categoria da CNH" value={q?.driver_license_category}/>
 </dl>
 {q?.has_cpf && !q.cpf && <Button className="mt-3" size="sm" variant="outline" onClick={() => load(true)}>Mostrar CPF</Button>}
 </section>
     <section className="rounded-lg border p-4"><h3 className="mb-3 font-medium">Resumo e próximo passo</h3><dl className="space-y-4"><details><summary className="cursor-pointer text-sm font-medium">Resumo e observações</summary><div className="mt-2 space-y-2">{distinctDisplayTexts([opportunity.sales_state?.handoffSummary, q?.summary, commercial.commercial_notes]).map((text, index) => <p key={index} className="whitespace-pre-wrap text-sm">{text}</p>)}</div></details><Field label="Próxima ação" value={o.next_action}/><Field label="Data combinada" value={o.next_action_due_date ? new Date(`${o.next_action_due_date}T12:00:00`).toLocaleDateString("pt-BR") : null}/>{o.lost_reason && <Field label="Motivo da perda" value={o.lost_reason}/>}</dl></section>
     <section className="rounded-lg border p-4"><h3 className="mb-3 font-medium">Tarefas pendentes</h3>{details?.tasks.length ? details.tasks.map(t => <div key={t.id} className="mb-3 rounded border p-3"><p className="whitespace-pre-wrap text-sm"><strong>{TASK_TYPE_LABELS[t.type] ?? t.type}</strong> — {displayText(t.description)}</p><p className="mt-1 text-xs text-muted-foreground">Retorno: {new Date(`${t.due_date}T12:00:00`).toLocaleDateString("pt-BR")}{!t.opportunity_id && " · Tarefa do contato, sem negócio vinculado"}</p>{workspaceEnabled && <Button className="mt-2" size="sm" variant="outline" onClick={() => setSelectedTask(t)}>Abrir tarefa e follow-up</Button>}</div>) : <p className="text-sm text-muted-foreground">Nenhuma tarefa vinculada.</p>}</section>{workspaceEnabled && selectedTask && <TaskDetailPanel embedded key={selectedTask.id} taskId={selectedTask.id} organizationId={o.organization_id} task={{...selectedTask,wa_contacts:details?.customer ?? null,conversations:null}} onClose={() => setSelectedTask(null)} onTaskChanged={() => { load(); onChanged(); }}/>}</div>
     <div className="space-y-4"><details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Dados do contato</summary><dl className="space-y-4"><Field label="Cidade" value={q?.city}/><Field label="Origem do lead" value={details?.origin ? LEAD_ORIGIN_LABELS[details.origin.source] ?? details.origin.source : null}/></dl><div className="mt-3 space-y-2"><Button size="sm" variant="outline" onClick={() => { setOriginSource(details?.origin?.source ?? "site_wix"); setOriginEditing(!originEditing); }}>Corrigir origem</Button>{originEditing && <><select aria-label="Origem do lead" className="block w-full rounded border bg-background p-2 text-sm" value={originSource} onChange={e => setOriginSource(e.target.value as LeadOriginSource)}>{Object.entries(LEAD_ORIGIN_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><Button size="sm" disabled={saving} onClick={saveOrigin}>Salvar origem</Button></>}</div></details>
     <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Ligações ({callLogs.length})</summary>{callLogs.length ? callLogs.map(c => <div key={c.id} className="mb-3 border-l-2 pl-3"><p className="text-sm font-medium">{CALL_OUTCOME_LABELS[c.outcome] ?? c.outcome} · {CALL_STRATEGY_LABELS[c.strategy] ?? c.strategy}{c.rep_name ? ` · ${c.rep_name}` : ""}</p>{c.note && <p className="whitespace-pre-wrap text-sm">{displayText(c.note)}</p>}<p className="text-xs text-muted-foreground">{new Date(c.called_at).toLocaleString("pt-BR")}</p></div>) : <p className="mt-2 text-sm text-muted-foreground">Nenhuma ligação registrada.</p>}</details>
     <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Histórico</summary>{details?.events.length ? details.events.map(e => <div key={e.id} className="mb-4 border-l-2 pl-3"><p className="text-sm font-medium">{eventLabels[e.event_type] ?? "Atualização"}</p><p className="whitespace-pre-wrap text-sm">{displayText(e.evidence)}</p><p className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString("pt-BR")}</p></div>) : <p className="text-sm text-muted-foreground">Sem eventos registrados.</p>}</details><details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Atribuição do lead</summary><AssignmentHistory contactId={o.contact_id} /></details></div>
    </div>
    {workspaceEnabled && details?.conversation && (chatOpen ? <aside className="sticky top-0 h-[65vh] min-w-0 overflow-hidden rounded-lg border"><ChatPanel compact key={details.conversation.id} conversationId={details.conversation.id} onClose={() => setChatOpen(false)} onConversationChanged={() => { load(); onChanged(); }}/></aside> : <Button variant="outline" onClick={() => setChatOpen(true)}>Mostrar conversa</Button>)}
    </div>
   </DialogContent>
  </Dialog>
  {callOpen && <CallLogDialog opportunityId={o.id} onClose={() => setCallOpen(false)} onSaved={loadCalls} onRequestReturnTask={o.status === "open" ? () => setFreezing(true) : undefined} />}
  {freezing && <OpportunityFreezeDialog opportunity={o} onClose={()=>setFreezing(false)} onSaved={()=>{load();onChanged()}}/>}
  {stage && <StageChangeDialog open fromLabel={FUNNEL_STAGE_LABELS[o.stage] ?? o.stage} toLabel={FUNNEL_STAGE_LABELS[stage] ?? stage} onConfirm={changeStage} onCancel={() => setStage(null)}/>}
  {editing && <OpportunityEditDialog opportunity={o} open onOpenChange={setEditing} onSaved={() => { load(); onChanged(); }}/ >}
 </>;
}
