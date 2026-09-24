"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrencyBRL } from "@/lib/utils";
import type { ConversationQualification } from "@aula-agente/shared";

interface QualificationPanelProps {
  conversationId: string;
}

const ATTENDANCE_TYPE_LABELS: Record<string, string> = {
  financing: "Financiamento",
  consortium: "Consórcio",
  cash: "À vista",
  workshop: "Oficina",
};

const URGENCY_LABELS: Record<string, string> = {
  immediate: "Imediata",
  this_week: "Essa semana",
  flexible: "Flexível",
};

// Every field here already exists in the DB (packages/shared's
// ConversationQualification, filled in by the AI's update_qualification
// tool) — this is pure UI wiring so a human taking over a conversation can
// see the same context the AI already had, instead of re-asking the
// customer or reading the whole thread from scratch.
export function QualificationPanel({ conversationId }: QualificationPanelProps) {
  const [qualification, setQualification] = useState<ConversationQualification | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchQualification = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("conversation_qualifications")
      .select("*")
      .eq("conversation_id", conversationId)
      .maybeSingle();
    setQualification((data as ConversationQualification) ?? null);
    setLoading(false);
  }, [conversationId]);

  useEffect(() => {
    setLoading(true);
    fetchQualification();
  }, [fetchQualification]);

  if (loading) return null;

  if (!qualification) {
    return <p className="text-xs text-muted-foreground">Sem qualificação registrada ainda.</p>;
  }

  const rows: Array<[string, string | null]> = [
    [
      "Modalidade",
      qualification.attendance_type
        ? (ATTENDANCE_TYPE_LABELS[qualification.attendance_type] ?? qualification.attendance_type)
        : null,
    ],
    ["Produto", qualification.product_interest],
    ["Modelo", qualification.product_model],
    ["Uso", qualification.usage_purpose],
    ["Cidade", qualification.city],
    ["Urgência", qualification.urgency ? (URGENCY_LABELS[qualification.urgency] ?? qualification.urgency) : null],
    ["Valor do bem", qualification.sale_amount !== null ? formatCurrencyBRL(qualification.sale_amount) : null],
    ["Crédito", qualification.credit_amount !== null ? formatCurrencyBRL(qualification.credit_amount) : null],
    [
      "Entrada",
      qualification.down_payment_amount !== null ? formatCurrencyBRL(qualification.down_payment_amount) : null,
    ],
    [
      "Parcela alvo",
      qualification.target_installment_amount !== null
        ? formatCurrencyBRL(qualification.target_installment_amount)
        : null,
    ],
    ["Prazo", qualification.term_months !== null ? `${qualification.term_months}x` : null],
  ].filter((row): row is [string, string] => row[1] !== null && row[1] !== "");

  return (
    <div className="space-y-3 text-xs">
      {rows.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1.5">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {qualification.next_action && (
        <div className="rounded-md border border-primary/20 bg-primary/10 p-2">
          <p className="font-semibold">Próxima ação</p>
          <p>{qualification.next_action}</p>
        </div>
      )}
      {qualification.summary && (
        <div>
          <p className="mb-1 font-semibold text-muted-foreground">Resumo</p>
          <p>{qualification.summary}</p>
        </div>
      )}
      {qualification.commercial_notes && (
        <div>
          <p className="mb-1 font-semibold text-muted-foreground">Observações comerciais</p>
          <p>{qualification.commercial_notes}</p>
        </div>
      )}
    </div>
  );
}
