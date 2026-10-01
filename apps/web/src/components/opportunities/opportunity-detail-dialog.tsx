"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useOrganization } from "@/providers/organization-provider";
import { ChatPanel } from "@/components/inbox/chat-panel";
import { TaskDetailPanel } from "@/components/tasks/task-detail-panel";
import { apiFetch } from "@/lib/api";
import { FUNNEL_STAGES, FUNNEL_STAGE_LABELS, OPERATION_LABELS, LEAD_ORIGIN_LABELS, TASK_TYPE_LABELS } from "@aula-agente/shared";
import type { Opportunity, OpportunityEvent, Task, LeadOriginSource } from "@aula-agente/shared";
import type { OpportunityWithContact } from "./opportunity-kanban";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { OpportunityEditDialog } from "./opportunity-edit-dialog";
import { StageChangeDialog } from "./stage-change-dialog";
interface Details {
 opportunity: Opportunity; customer: { name: string | null; phone: string };
 conversation: { id: string } | null;
 qualification: { cpf: string | null; has_cpf: boolean; summary?: string | null; product_interest?: string | null; product_model?: string | null; city?: string | null; birth_date?: string | null; has_driver_license?: boolean | null; driver_license_category?: string | null; target_installment_amount?: number | null; down_payment_amount?: number | null; commercial_notes?: string | null } | null;
 origin: { source: LeadOriginSource; evidence?: string } | null;
 tasks: Task[]; events: OpportunityEvent[];
}
const money = (value: number | null | undefined) => value == null ? "Não informado" : Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const eventLabels: Record<string, string> = { created: "Oportunidade criada", stage_changed: "Etapa alterada", operation_changed: "Operação alterada", won: "Negócio ganho", lost: "Negócio perdido", owner_changed: "Responsável alterado", next_action_updated: "Próxima ação atualizada", waiting_on_changed: "Pendência atualizada", reopened: "Reaberta" };
function Field({ label, value }: { label: string; value?: string | number | null }) { return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{value ?? "Não informado"}</dd></div>; }
export function OpportunityDetailDialog({ opportunity, onClose, onChanged }: { opportunity: OpportunityWithContact; onClose: () => void; onChanged: () => void }) {
 const { currentOrg } = useOrganization();
 const workspaceEnabled = currentOrg?.settings.sales_workspace_enabled === true;
 const [selectedTask, setSelectedTask] = useState<Task | null>(null);
 const [chatOpen, setChatOpen] = useState(true);
 const [details, setDetails] = useState<Details | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [originEditing, setOriginEditing] = useState(false);
 const [originSource, setOriginSource] = useState<LeadOriginSource>("site_wix");
 const [editing, setEditing] = useState(false);
 const [stage, setStage] = useState<string | null>(null);
 const [closing, setClosing] = useState<"won" | "lost" | null>(null);
 const [evidence, setEvidence] = useState(""); const [reason, setReason] = useState("sem_resposta"); const [saving, setSaving] = useState(false);
 const load = useCallback(async (reveal = false) => { try { setError(null); setDetails(await apiFetch(`/opportunities/${opportunity.id}/details${reveal ? "?revealCpf=true" : ""}`)); } catch (err) { setError((err as Error).message); } }, [opportunity.id]);
 useEffect(() => { load(); }, [load]);
 const o = details?.opportunity ?? opportunity; const q = details?.qualification;
 async function changeStage(e: string) { await apiFetch(`/opportunities/${o.id}/stage`, { method: "POST", body: JSON.stringify({ stage, evidence: e }) }); setStage(null); await load(); onChanged(); }
 async function saveOrigin() { setSaving(true); try { await apiFetch(`/opportunities/${o.id}/origin`, { method: "PATCH", body: JSON.stringify({ source: originSource }) }); setOriginEditing(false); await load(); } catch (err) { setError((err as Error).message); } finally { setSaving(false); } }
 async function closeDeal() {
  if (!closing || !evidence.trim()) { setError("Descreva o que confirma essa decisão."); return; }
  setSaving(true); try { await apiFetch(`/opportunities/${o.id}/${closing}`, { method: "POST", body: JSON.stringify({ evidence: evidence.trim(), ...(closing === "lost" ? { lost_reason: reason } : {}) }) }); setClosing(null); setEvidence(""); await load(); onChanged(); } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
 }
 return <>
  <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
   <DialogContent className="w-[95vw] sm:max-w-7xl max-h-[90vh] overflow-y-auto">
    <DialogHeader><DialogTitle>{details?.customer.name || opportunity.wa_contacts?.name || "Detalhes do lead"}</DialogTitle><p className="text-sm text-muted-foreground">{OPERATION_LABELS[o.operation]} · {details?.customer.phone || opportunity.wa_contacts?.phone} · {o.status === "open" ? "Em andamento" : o.status === "won" ? "Ganho" : "Perdido"}</p></DialogHeader>
    {workspaceEnabled && opportunity.sales_state?.humanPending && <section className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"><strong>Encaminhado pela Mariana</strong><p className="mt-1 whitespace-pre-wrap">{opportunity.sales_state.handoffSummary || "Cliente aguardando atendimento humano."}</p>{opportunity.sales_state.handedAt && <p className="mt-1 text-xs text-muted-foreground">Aguardando desde {new Date(opportunity.sales_state.handedAt).toLocaleString("pt-BR")}</p>}</section>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!details && <Button variant="outline" onClick={() => load()}>Carregar detalhes</Button>}
    <div className="flex flex-wrap gap-2">{FUNNEL_STAGES[o.operation].map(s => <Button key={s} size="sm" variant={s === o.stage ? "default" : "outline"} disabled={o.status !== "open" || s === o.stage} onClick={() => setStage(s)}>{FUNNEL_STAGE_LABELS[s] ?? s}</Button>)}</div>
    <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setEditing(true)}>Editar dados</Button>{details?.conversation && <Link className={buttonVariants({ variant: "outline" })} href={`/inbox?id=${details.conversation.id}`}>Abrir conversa</Link>}{o.status === "open" && <><Button onClick={() => { setError(null); setClosing("won"); }}>Marcar como ganho</Button><Button variant="destructive" onClick={() => { setError(null); setClosing("lost"); }}>Marcar como perdido</Button></>}</div>
    {closing && <section className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">Confirmar negócio {closing === "won" ? "ganho" : "perdido"}</h3>{closing === "lost" && <label className="block text-sm">Motivo<select className="mt-1 block w-full rounded border bg-background p-2" value={reason} onChange={e => setReason(e.target.value)}><option value="sem_resposta">Sem resposta</option><option value="preco">Preço</option><option value="sem_interesse">Sem interesse</option><option value="comprou_outro">Comprou em outro lugar</option><option value="outro">Outro (descreva abaixo)</option></select></label>}<label className="block text-sm">O que confirma essa decisão?<Textarea value={evidence} onChange={e => setEvidence(e.target.value)} /></label><div className="flex gap-2"><Button disabled={saving || !evidence.trim()} onClick={closeDeal}>{saving ? "Salvando..." : "Confirmar"}</Button><Button variant="outline" disabled={saving} onClick={() => setClosing(null)}>Cancelar</Button></div></section>}
    <div className={workspaceEnabled && details?.conversation && chatOpen ? "grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : ""}>
    <div className="grid gap-5 md:grid-cols-[1.5fr_1fr]">
     <div className="space-y-4"><section className="rounded-lg border p-4"><h3 className="mb-3 font-medium">Interesse e condições</h3><dl className="grid grid-cols-2 gap-4"><Field label="Bem desejado" value={o.product_model ?? q?.product_model ?? q?.product_interest ?? o.product}/><Field label="Parcela confortável" value={money(o.target_installment_amount ?? q?.target_installment_amount)}/><Field label="Entrada" value={money(o.down_payment_amount ?? q?.down_payment_amount)}/><Field label="Prazo (meses)" value={o.term_months}/><Field label="Valor do bem" value={money(o.sale_amount)}/><Field label="Crédito" value={money(o.credit_amount)}/><Field label="Lance" value={money(o.bid_amount)}/><Field label="Urgência" value={o.urgency}/><Field label="Finalidade" value={o.usage_purpose}/><Field label="Objeção / restrição" value={o.main_objection}/></dl></section>
     <section className="rounded-lg border p-4"><h3 className="mb-3 font-medium">Resumo e próximo passo</h3><dl className="space-y-4"><Field label="Resumo do atendimento" value={q?.summary}/><Field label="Observações" value={o.commercial_notes ?? q?.commercial_notes}/><Field label="Próxima ação" value={o.next_action}/><Field label="Data combinada" value={o.next_action_due_date}/>{o.lost_reason && <Field label="Motivo da perda" value={o.lost_reason}/>}</dl></section>
     <section className="rounded-lg border p-4"><h3 className="mb-3 font-medium">Tarefas pendentes</h3>{details?.tasks.length ? details.tasks.map(t => <div key={t.id} className="mb-3 rounded border p-3"><p className="whitespace-pre-wrap text-sm"><strong>{TASK_TYPE_LABELS[t.type] ?? t.type}</strong> — {t.description}</p><p className="mt-1 text-xs text-muted-foreground">Retorno: {t.due_date}{!t.opportunity_id && " · Tarefa do contato, sem negócio vinculado"}</p>{workspaceEnabled && <Button className="mt-2" size="sm" variant="outline" onClick={() => setSelectedTask(t)}>Abrir tarefa e follow-up</Button>}</div>) : <p className="text-sm text-muted-foreground">Nenhuma tarefa vinculada.</p>}</section>{workspaceEnabled && selectedTask && <TaskDetailPanel embedded key={selectedTask.id} taskId={selectedTask.id} organizationId={o.organization_id} task={{...selectedTask,wa_contacts:details?.customer ?? null,conversations:null}} onClose={() => setSelectedTask(null)} onTaskChanged={() => { load(); onChanged(); }}/>}</div>
     <div className="space-y-4"><section className="rounded-lg border p-4"><h3 className="mb-3 font-medium">Dados do contato</h3><dl className="space-y-4"><Field label="Nome" value={details?.customer.name}/><Field label="Telefone" value={details?.customer.phone}/><Field label="CPF" value={q?.cpf ?? (q?.has_cpf ? "Oculto" : null)}/>{q?.has_cpf && !q.cpf && <Button size="sm" variant="outline" onClick={() => load(true)}>Mostrar CPF</Button>}<Field label="Cidade" value={q?.city}/><Field label="Nascimento" value={q?.birth_date}/><Field label="CNH" value={q?.has_driver_license == null ? null : q.has_driver_license ? "Sim" : "Não"}/><Field label="Categoria da CNH" value={q?.driver_license_category}/><Field label="Origem do lead" value={details?.origin ? LEAD_ORIGIN_LABELS[details.origin.source] ?? details.origin.source : null}/></dl><div className="mt-3 space-y-2"><Button size="sm" variant="outline" onClick={() => { setOriginSource(details?.origin?.source ?? "site_wix"); setOriginEditing(!originEditing); }}>Corrigir origem</Button>{originEditing && <><select aria-label="Origem do lead" className="block w-full rounded border bg-background p-2 text-sm" value={originSource} onChange={e => setOriginSource(e.target.value as LeadOriginSource)}>{Object.entries(LEAD_ORIGIN_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><Button size="sm" disabled={saving} onClick={saveOrigin}>Salvar origem</Button></>}</div></section>
     <section className="rounded-lg border p-4"><h3 className="mb-3 font-medium">Histórico</h3>{details?.events.length ? details.events.map(e => <div key={e.id} className="mb-4 border-l-2 pl-3"><p className="text-sm font-medium">{eventLabels[e.event_type] ?? "Atualização"}</p><p className="whitespace-pre-wrap text-sm">{e.evidence}</p><p className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString("pt-BR")}</p></div>) : <p className="text-sm text-muted-foreground">Sem eventos registrados.</p>}</section></div>
    </div>
    {workspaceEnabled && details?.conversation && (chatOpen ? <aside className="sticky top-0 h-[65vh] min-w-0 overflow-hidden rounded-lg border"><ChatPanel compact key={details.conversation.id} conversationId={details.conversation.id} onClose={() => setChatOpen(false)} onConversationChanged={() => { load(); onChanged(); }}/></aside> : <Button variant="outline" onClick={() => setChatOpen(true)}>Mostrar conversa</Button>)}
    </div>
   </DialogContent>
  </Dialog>
  {stage && <StageChangeDialog open fromLabel={FUNNEL_STAGE_LABELS[o.stage] ?? o.stage} toLabel={FUNNEL_STAGE_LABELS[stage] ?? stage} onConfirm={changeStage} onCancel={() => setStage(null)}/>}
  {editing && <OpportunityEditDialog opportunity={o} open onOpenChange={setEditing} onSaved={() => { setEditing(false); load(); onChanged(); }}/ >}
 </>;
}
