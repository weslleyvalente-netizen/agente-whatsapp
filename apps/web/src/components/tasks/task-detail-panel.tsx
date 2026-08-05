"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { formatPhone } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { QualificationSection, type QualificationFieldDescriptor } from "./qualification-section";

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
    { key: "sale_amount", label: "Valor da venda", kind: "currency" },
  ];
  const financialFields: QualificationFieldDescriptor[] =
    attendanceType === "consortium"
      ? [
          { key: "credit_amount", label: "Crédito desejado", kind: "currency" },
          { key: "bid_amount", label: "Lance", kind: "currency" },
        ]
      : [{ key: "down_payment_amount", label: "Entrada", kind: "currency" }];
  return [
    ...base,
    ...financialFields,
    { key: "target_installment_amount", label: "Parcela desejada", kind: "currency" },
    { key: "term_months", label: "Prazo (meses)", kind: "number" },
    { key: "next_action", label: "Próxima ação", kind: "text" },
    { key: "commercial_notes", label: "Observações", kind: "textarea" },
  ];
}

function openWhatsApp(phone: string) {
  const digits = phone.replace(/\D/g, "");
  const withCountryCode = digits.startsWith("55") ? digits : `55${digits}`;
  window.open(`https://wa.me/${withCountryCode}`, "_blank");
}

interface TaskDetailPanelProps {
  taskId: string;
  onClose: () => void;
  onTaskChanged: () => void;
}

export function TaskDetailPanel({ taskId, onClose, onTaskChanged }: TaskDetailPanelProps) {
  const router = useRouter();
  const [details, setDetails] = useState<TaskDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

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

  const isOpenTask = details ? details.task.status !== "completed" && details.task.status !== "cancelled" : false;
  const qualification = details?.qualification ?? EMPTY_QUALIFICATION;
  const attendanceType = qualification.attendance_type;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{details?.customer?.name || (details?.customer ? formatPhone(details.customer.phone) : "Tarefa")}</SheetTitle>
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
            {details.customer && <p className="text-sm text-muted-foreground">{formatPhone(details.customer.phone)}</p>}

            <div className="flex flex-wrap gap-2">
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
                <Button size="sm" onClick={handleComplete}>
                  Concluir
                </Button>
              )}
            </div>

            <Separator />

            <QualificationSection
              title="Resumo do atendimento"
              fields={SUMMARY_FIELDS}
              values={qualification as unknown as Record<string, unknown>}
              onSave={handleSaveSection}
            />

            <Separator />

            <QualificationSection
              title="Dados do cliente"
              fields={CLIENT_FIELDS}
              values={qualification as unknown as Record<string, unknown>}
              onSave={handleSaveSection}
            />
            {details.conversation && (
              <p className="text-xs text-muted-foreground">
                Última interação: {new Date(details.conversation.lastMessageAt).toLocaleString("pt-BR")}
              </p>
            )}

            <Separator />

            <QualificationSection
              title="Informações comerciais"
              fields={commercialFields(attendanceType)}
              values={qualification as unknown as Record<string, unknown>}
              onSave={handleSaveSection}
            />

            {attendanceType === "financing" && (
              <>
                <Separator />
                <QualificationSection
                  title="Financiamento"
                  fields={FINANCING_FIELDS}
                  values={qualification as unknown as Record<string, unknown>}
                  onSave={handleSaveSection}
                />
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
