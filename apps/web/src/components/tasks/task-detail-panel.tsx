"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { formatCurrencyBRL, formatPhone, formatRelativeTime } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { QualificationSection, sectionHasContent, type QualificationFieldDescriptor } from "./qualification-section";
import type { TaskWithRelations } from "./task-card";
import { RescheduleDialog } from "./reschedule-dialog";
import { TaskDialog } from "./task-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Pencil, MoreVertical, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { TASK_TYPE_LABELS, TASK_PRIORITY_LABELS, TASK_FOLLOWUP_ELIGIBLE_TYPES } from "@aula-agente/shared";

interface QualificationValues {
  attendance_type: string | null;
  product_interest: string | null;
  product_model: string | null;
  usage_purpose: string | null;
  city: string | null;
  urgency: string | null;
  sale_amount: number | null;
  credit_amount: number | null;
  down_payment_amount: number | null;
  bid_amount: number | null;
  target_installment_amount: number | null;
  term_months: number | null;
  cpf: string | null;
  birth_date: string | null;
  has_driver_license: boolean | null;
  driver_license_category: string | null;
  summary: string | null;
  next_action: string | null;
  commercial_notes: string | null;
}

interface TaskDetails {
  task: {
    id: string;
    status: string;
    priority: string;
    due_date: string;
    due_time: string | null;
    conversation_id: string | null;
  };
  customer: { id: string; name: string | null; phone: string } | null;
  conversation: { id: string; lastMessageAt: string } | null;
  qualification: QualificationValues | null;
}

const EMPTY_QUALIFICATION: QualificationValues = {
  attendance_type: null,
  product_interest: null,
  product_model: null,
  usage_purpose: null,
  city: null,
  urgency: null,
  sale_amount: null,
  credit_amount: null,
  down_payment_amount: null,
  bid_amount: null,
  target_installment_amount: null,
  term_months: null,
  cpf: null,
  birth_date: null,
  has_driver_license: null,
  driver_license_category: null,
  summary: null,
  next_action: null,
  commercial_notes: null,
};

const URGENCY_OPTIONS = [
  { value: "immediate", label: "Imediata" },
  { value: "this_week", label: "Essa semana" },
  { value: "flexible", label: "Flexível" },
];

const ATTENDANCE_TYPE_OPTIONS = [
  { value: "financing", label: "Financiamento" },
  { value: "consortium", label: "Consórcio" },
  { value: "cash", label: "À vista" },
  { value: "workshop", label: "Oficina/peças" },
];

const CLIENT_FIELDS: QualificationFieldDescriptor[] = [
  { key: "attendance_type", label: "Tipo de atendimento", kind: "select", options: ATTENDANCE_TYPE_OPTIONS },
  { key: "city", label: "Cidade", kind: "text" },
  { key: "usage_purpose", label: "Finalidade de uso", kind: "text" },
  { key: "urgency", label: "Urgência", kind: "select", options: URGENCY_OPTIONS },
];

const SUMMARY_FIELDS: QualificationFieldDescriptor[] = [{ key: "summary", label: "Resumo", kind: "textarea" }];

const FINANCING_FIELDS: QualificationFieldDescriptor[] = [
  { key: "cpf", label: "CPF", kind: "text" },
  { key: "birth_date", label: "Nascimento", kind: "date" },
  { key: "has_driver_license", label: "Possui CNH", kind: "boolean" },
  { key: "driver_license_category", label: "Categoria da CNH", kind: "text" },
];

function commercialFields(attendanceType: string | null): QualificationFieldDescriptor[] {
  const base: QualificationFieldDescriptor[] = [
    { key: "product_interest", label: "Produto", kind: "text" },
    { key: "product_model", label: "Modelo", kind: "text" },
    { key: "sale_amount", label: "Valor da venda", kind: "currency", emphasize: true },
  ];
  const downPayment: QualificationFieldDescriptor[] =
    attendanceType === "consortium" ? [] : [{ key: "down_payment_amount", label: "Entrada", kind: "currency", emphasize: true }];
  return [
    ...base,
    ...downPayment,
    { key: "target_installment_amount", label: "Parcela desejada", kind: "currency", emphasize: true },
    { key: "term_months", label: "Prazo (meses)", kind: "number", emphasize: true },
    { key: "next_action", label: "Próxima ação", kind: "text", hideInView: true },
  ];
}

const CONSORTIUM_FIELDS: QualificationFieldDescriptor[] = [
  { key: "credit_amount", label: "Crédito desejado", kind: "currency", emphasize: true },
  { key: "bid_amount", label: "Lance", kind: "currency", emphasize: true },
];

const OBSERVATION_FIELDS: QualificationFieldDescriptor[] = [
  { key: "commercial_notes", label: "Observações", kind: "textarea" },
];

function openWhatsApp(phone: string) {
  const digits = phone.replace(/\D/g, "");
  const withCountryCode = digits.startsWith("55") ? digits : `55${digits}`;
  window.open(`https://wa.me/${withCountryCode}`, "_blank");
}

interface TaskDetailPanelProps {
  task: TaskWithRelations;
  taskId: string;
  organizationId: string;
  onClose: () => void;
  onTaskChanged: () => void;
}

export function TaskDetailPanel({ task, taskId, organizationId, onClose, onTaskChanged }: TaskDetailPanelProps) {
  const router = useRouter();
  const [details, setDetails] = useState<TaskDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [forceShowGeneric, setForceShowGeneric] = useState(false);

  // Follow-up direto da tarefa (docs/plano-followup-tarefa.md). The block is
  // hidden entirely when the backend rejects it (feature off, task type not
  // eligible, no conversation, gated by an unarrived scheduled_date) — the
  // 400/404 from the first suggestion fetch is the real eligibility check,
  // this client-side type check is just to avoid firing it needlessly.
  const [followupLoaded, setFollowupLoaded] = useState(false);
  const [followupUnavailable, setFollowupUnavailable] = useState(false);
  const [followupLoading, setFollowupLoading] = useState(false);
  const [followupText, setFollowupText] = useState("");
  const [regenerationsRemaining, setRegenerationsRemaining] = useState<number | null>(null);
  const [followupTouch, setFollowupTouch] = useState<{
    lastTouchAt: string | null;
    lastTouchBy: "agent" | "human_agent" | null;
    touchCount: number;
  } | null>(null);
  const [followupError, setFollowupError] = useState<string | null>(null);
  // Set when the last send attempt came back with canForce (recent_touch,
  // touch_limit_reached, or unconfirmed) — the panel then shows a "confirmar
  // mesmo assim" button with an explicit duplicate-risk warning instead of
  // silently retrying.
  const [followupBlock, setFollowupBlock] = useState<{
    reason: string;
    message: string;
    suggestMarkLost?: boolean;
  } | null>(null);
  const [sending, setSending] = useState(false);

  const fetchDetails = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await apiFetch(`/tasks/${taskId}/details`);
      setDetails(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  const fetchFollowupSuggestion = useCallback(async (regenerate = false) => {
    setFollowupLoading(true);
    setFollowupError(null);
    try {
      const data = await apiFetch(`/tasks/${taskId}/followup-suggestion`, { method: "POST", body: JSON.stringify({ regenerate }) });
      setFollowupText(data.message);
      setFollowupLoaded(true);
      setRegenerationsRemaining(data.regenerationsRemaining);
      setFollowupTouch(data.touch ?? null);
      setFollowupUnavailable(false);
    } catch (error) {
      const err = error as Error & { status?: number; body?: { regenerationsRemaining?: number } };
      setFollowupUnavailable(err.status === 400 || err.status === 404);
      setFollowupError(err.message);
      if (err.body?.regenerationsRemaining !== undefined) setRegenerationsRemaining(err.body.regenerationsRemaining);
    } finally {
      setFollowupLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (!details) return;
    const isOpen = details.task.status !== "completed" && details.task.status !== "cancelled";
    if (!isOpen || !TASK_FOLLOWUP_ELIGIBLE_TYPES.includes(task.type)) {
      setFollowupUnavailable(true);
      return;
    }
    fetchFollowupSuggestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details?.task.status]);

  const handleSendFollowup = async (force = false) => {
    if (!details?.customer) return;
    const who = details.customer.name || formatPhone(details.customer.phone);
    if (!force && !confirm(`Enviar esta mensagem para ${who}?\n\n${followupText}`)) return;

    setSending(true);
    setFollowupError(null);
    setFollowupBlock(null);
    try {
      await apiFetch(`/tasks/${taskId}/send-followup`, {
        method: "POST",
        body: JSON.stringify({ message: followupText, ...(force ? { force: true } : {}) }),
      });
      onTaskChanged();
      await fetchDetails();
    } catch (err) {
      const body = (err as { body?: { reason?: string; canForce?: boolean; suggestMarkLost?: boolean; hoursSinceTouch?: number; touchCount?: number } })?.body;
      if (body?.canForce) {
        const messageByReason: Record<string, string> = {
          recent_touch: `Já houve contato de saída há ${body.hoursSinceTouch?.toFixed(1)}h. Enviar mesmo assim pode soar repetitivo para o cliente.`,
          touch_limit_reached: `Já foram ${body.touchCount} tentativas de contato sem resposta. Considere marcar a oportunidade como perdida (motivo: sem resposta) em vez de tentar de novo.`,
          unconfirmed: "O envio anterior não foi confirmado — pode já ter chegado ao cliente. Enviar de novo agora pode duplicar a mensagem.",
        };
        setFollowupBlock({
          reason: body.reason ?? "blocked",
          message: messageByReason[body.reason ?? ""] ?? "Envio bloqueado.",
          suggestMarkLost: body.suggestMarkLost,
        });
      } else {
        setFollowupError(err instanceof Error ? err.message : "Erro ao enviar o follow-up");
      }
    } finally {
      setSending(false);
    }
  };

  const handleSaveSection = async (patch: Record<string, unknown>) => {
    if (!details?.conversation) {
      throw new Error("Esta tarefa não tem conversa vinculada — não é possível editar a qualificação.");
    }
    await apiFetch(`/conversations/${details.conversation.id}/qualification`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    await fetchDetails();
  };

  const handleComplete = async () => {
    try {
      await apiFetch(`/tasks/${taskId}/complete`, { method: "POST" });
      onTaskChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao concluir tarefa");
    }
  };

  const handleCancel = async () => {
    if (!confirm("Cancelar esta tarefa?")) return;
    try {
      await apiFetch(`/tasks/${taskId}/cancel`, { method: "POST", body: JSON.stringify({}) });
      onTaskChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao cancelar tarefa");
    }
  };

  const isOpenTask = details ? details.task.status !== "completed" && details.task.status !== "cancelled" : false;
  const qualification = details?.qualification ?? EMPTY_QUALIFICATION;
  const attendanceType = qualification.attendance_type;

  const commercialHasContent = sectionHasContent(
    commercialFields(attendanceType).filter((f) => !f.hideInView),
    qualification as unknown as Record<string, unknown>
  );
  const clientHasContent = sectionHasContent(CLIENT_FIELDS, qualification as unknown as Record<string, unknown>);
  const hasAnyQualificationSection =
    commercialHasContent ||
    clientHasContent ||
    (attendanceType === "financing" &&
      sectionHasContent(FINANCING_FIELDS, qualification as unknown as Record<string, unknown>)) ||
    (attendanceType === "consortium" &&
      sectionHasContent(CONSORTIUM_FIELDS, qualification as unknown as Record<string, unknown>)) ||
    sectionHasContent(OBSERVATION_FIELDS, qualification as unknown as Record<string, unknown>);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" showCloseButton={false}>
        <SheetHeader>
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>{details?.customer?.name || (details?.customer ? formatPhone(details.customer.phone) : "Tarefa")}</SheetTitle>
            <div className="flex shrink-0 items-center gap-1">
              {isOpenTask && (
                <TaskDialog
                  organizationId={organizationId}
                  task={task}
                  presetContact={{ id: task.contact_id, name: task.wa_contacts?.name ?? null, phone: task.wa_contacts?.phone ?? "" }}
                  triggerButton={<Button variant="ghost" size="icon-sm" />}
                  triggerLabel={<Pencil className="size-3.5" />}
                  onSaved={onTaskChanged}
                />
              )}
              <Button variant="ghost" size="icon-sm" onClick={onClose}>
                <XIcon className="size-3.5" />
                <span className="sr-only">Fechar</span>
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {details?.customer ? formatPhone(details.customer.phone) : ""} · {TASK_TYPE_LABELS[task.type]}
          </p>
          <div className="flex items-center justify-between gap-2">
            <Badge variant="secondary">{TASK_PRIORITY_LABELS[task.priority]}</Badge>
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(details?.conversation?.lastMessageAt)}
            </span>
          </div>
        </SheetHeader>

        {loading && <p className="p-4 text-sm text-muted-foreground">Carregando...</p>}

        {error && (
          <div className="p-4">
            <p className="text-sm text-destructive">Não foi possível carregar os detalhes.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={fetchDetails}>
              Tentar de novo
            </Button>
          </div>
        )}

        {details && !loading && !error && (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!isOpenTask}
                onClick={handleComplete}
              >
                Concluir
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!details.task.conversation_id}
                onClick={() => details.task.conversation_id && router.push(`/inbox?id=${details.task.conversation_id}`)}
                title={!details.task.conversation_id ? "Esta tarefa não tem conversa vinculada" : undefined}
              >
                Abrir conversa
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!details.customer?.phone}
                onClick={() => details.customer?.phone && openWhatsApp(details.customer.phone)}
                title={!details.customer?.phone ? "Telefone indisponível" : undefined}
              >
                WhatsApp
              </Button>
              {isOpenTask && (
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="ml-auto" />}>
                    <MoreVertical className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <RescheduleDialog task={task} onRescheduled={onTaskChanged} />
                    <DropdownMenuItem variant="destructive" onClick={handleCancel}>
                      Cancelar tarefa
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>

            <QualificationSection
              title="Resumo do atendimento"
              fields={SUMMARY_FIELDS}
              values={qualification as unknown as Record<string, unknown>}
              onSave={handleSaveSection}
              truncateSummary
              hideTitle
              emptyFallback="Nenhum resumo disponível ainda."
            />

            {isOpenTask && !followupUnavailable && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">Follow-up</p>
                {followupTouch && (
                  <p className="text-xs text-muted-foreground">
                    {followupTouch.lastTouchAt
                      ? `Último toque: ${followupTouch.lastTouchBy === "agent" ? "Helena" : "atendente"}, ${formatRelativeTime(followupTouch.lastTouchAt)}. `
                      : "Nenhum toque pendente — o cliente respondeu por último. "}
                    {followupTouch.touchCount} toque(s) sem resposta.
                  </p>
                )}
                {followupLoading && !followupText && (
                  <p className="text-sm text-muted-foreground">Gerando sugestão...</p>
                )}
                {!followupText && followupError && <div className="space-y-2"><p className="text-sm text-destructive">{followupError}</p><Button size="sm" disabled={followupLoading} onClick={() => fetchFollowupSuggestion()}>Tentar novamente</Button></div>}
                {followupLoaded && (
                  <>
                    <Textarea
                      value={followupText}
                      onChange={(e) => setFollowupText(e.target.value)}
                      rows={4}
                      disabled={sending}
                    />
                    {followupError && <p className="text-sm text-destructive">{followupError}</p>}
                    {followupBlock && (
                      <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2">
                        <p className="text-sm">{followupBlock.message}</p>
                        {followupBlock.suggestMarkLost && (
                          <p className="text-xs text-muted-foreground">
                            Considere marcar a oportunidade como perdida (motivo: sem resposta) em vez de insistir.
                          </p>
                        )}
                        <Button size="sm" variant="destructive" disabled={sending} onClick={() => handleSendFollowup(true)}>
                          Confirmar envio mesmo assim
                        </Button>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" onClick={() => handleSendFollowup()} disabled={sending || !followupText.trim()}>
                        {sending ? "Enviando..." : "Enviar e concluir"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={sending || followupLoading || regenerationsRemaining === 0}
                        onClick={() => fetchFollowupSuggestion(true)}
                        title={regenerationsRemaining === 0 ? "Limite de regenerações atingido" : undefined}
                      >
                        {followupLoading ? "Gerando..." : "Gerar outra"}
                      </Button>
                      {regenerationsRemaining !== null && (
                        <span className="text-xs text-muted-foreground">
                          {regenerationsRemaining} regeneração(ões) restante(s)
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {!hasAnyQualificationSection && !forceShowGeneric && (
              <button
                type="button"
                className="text-sm font-medium text-primary hover:underline"
                onClick={() => setForceShowGeneric(true)}
              >
                + Adicionar informações
              </button>
            )}

            <Accordion key={forceShowGeneric ? "forced" : "default"} defaultValue={forceShowGeneric ? ["comercial", "cliente"] : ["comercial"]}>
              {(forceShowGeneric || commercialHasContent) && (
                <AccordionItem value="comercial">
                  <AccordionTrigger>Informações comerciais</AccordionTrigger>
                  <AccordionContent>
                    <QualificationSection
                      title="Informações comerciais"
                      fields={commercialFields(attendanceType)}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                      hideTitle
                      startInEditMode={forceShowGeneric && !commercialHasContent}
                    />
                    {attendanceType === "financing" &&
                      qualification.sale_amount != null &&
                      qualification.down_payment_amount != null && (
                        <div className="mt-2 rounded-md border bg-muted/30 p-2">
                          <p className="text-lg font-semibold">
                            {formatCurrencyBRL(qualification.sale_amount - qualification.down_payment_amount)}
                          </p>
                          <p className="text-xs text-muted-foreground">Valor a financiar</p>
                        </div>
                      )}
                  </AccordionContent>
                </AccordionItem>
              )}

              {(forceShowGeneric || clientHasContent) && (
                <AccordionItem value="cliente">
                  <AccordionTrigger>Dados do cliente</AccordionTrigger>
                  <AccordionContent>
                    <QualificationSection
                      title="Dados do cliente"
                      fields={CLIENT_FIELDS}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                      hideTitle
                      startInEditMode={forceShowGeneric && !clientHasContent}
                    />
                    {details.conversation && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Última interação: {new Date(details.conversation.lastMessageAt).toLocaleString("pt-BR")}
                      </p>
                    )}
                  </AccordionContent>
                </AccordionItem>
              )}

              {attendanceType === "financing" &&
                sectionHasContent(FINANCING_FIELDS, qualification as unknown as Record<string, unknown>) && (
                  <AccordionItem value="financiamento">
                    <AccordionTrigger>Financiamento</AccordionTrigger>
                    <AccordionContent>
                      <QualificationSection
                        title="Financiamento"
                        fields={FINANCING_FIELDS}
                        values={qualification as unknown as Record<string, unknown>}
                        onSave={handleSaveSection}
                        hideTitle
                      />
                    </AccordionContent>
                  </AccordionItem>
                )}

              {attendanceType === "consortium" &&
                sectionHasContent(CONSORTIUM_FIELDS, qualification as unknown as Record<string, unknown>) && (
                  <AccordionItem value="consorcio">
                    <AccordionTrigger>Consórcio</AccordionTrigger>
                    <AccordionContent>
                      <QualificationSection
                        title="Consórcio"
                        fields={CONSORTIUM_FIELDS}
                        values={qualification as unknown as Record<string, unknown>}
                        onSave={handleSaveSection}
                        hideTitle
                      />
                    </AccordionContent>
                  </AccordionItem>
                )}

              {sectionHasContent(OBSERVATION_FIELDS, qualification as unknown as Record<string, unknown>) && (
                <AccordionItem value="observacoes">
                  <AccordionTrigger>Observações</AccordionTrigger>
                  <AccordionContent>
                    <QualificationSection
                      title="Observações"
                      fields={OBSERVATION_FIELDS}
                      values={qualification as unknown as Record<string, unknown>}
                      onSave={handleSaveSection}
                      hideTitle
                    />
                  </AccordionContent>
                </AccordionItem>
              )}
            </Accordion>

            {qualification.next_action && (
              <div className="rounded-md border bg-muted/30 p-2">
                <p className="text-xs text-muted-foreground">Próxima ação</p>
                <p className="text-sm font-medium">{qualification.next_action}</p>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
