"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrencyBRL } from "@/lib/utils";

export type QualificationFieldDescriptor =
  | { key: string; label: string; kind: "text"; emphasize?: boolean; hideInView?: boolean }
  | { key: string; label: string; kind: "textarea"; emphasize?: boolean; hideInView?: boolean }
  | { key: string; label: string; kind: "number"; emphasize?: boolean; hideInView?: boolean }
  | { key: string; label: string; kind: "currency"; emphasize?: boolean; hideInView?: boolean }
  | { key: string; label: string; kind: "date"; emphasize?: boolean; hideInView?: boolean }
  | { key: string; label: string; kind: "boolean"; emphasize?: boolean; hideInView?: boolean }
  | {
      key: string;
      label: string;
      kind: "select";
      options: Array<{ value: string; label: string }>;
      emphasize?: boolean;
      hideInView?: boolean;
    };

export function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

export function sectionHasContent(fields: QualificationFieldDescriptor[], values: Record<string, unknown>): boolean {
  return fields.some((f) => hasValue(values[f.key]));
}

export function formatReadValue(field: QualificationFieldDescriptor, value: unknown): string | null {
  if (!hasValue(value)) return null;
  if (field.kind === "currency") return formatCurrencyBRL(value as number);
  if (field.kind === "boolean") return value === true ? "Sim" : "Não";
  if (field.kind === "date") return new Date(`${value}T00:00:00`).toLocaleDateString("pt-BR");
  if (field.kind === "select") return field.options.find((o) => o.value === value)?.label ?? String(value);
  return String(value);
}

function TruncatedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <p className={expanded ? "text-sm" : "line-clamp-3 text-sm"}>{text}</p>
      <button
        type="button"
        className="mt-1 text-xs font-medium text-primary hover:underline"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? "Mostrar menos" : "Mostrar mais"}
      </button>
    </div>
  );
}

function draftToPatch(
  fields: QualificationFieldDescriptor[],
  draft: Record<string, string>,
  values: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = draft[f.key] ?? "";
    let newValue: unknown;
    if (f.kind === "number" || f.kind === "currency") {
      newValue = raw === "" ? null : Number(raw);
    } else if (f.kind === "boolean") {
      newValue = raw === "" ? null : raw === "true";
    } else {
      newValue = raw === "" ? null : raw;
    }
    const currentValue = values[f.key] ?? null;
    // Only send fields that actually changed — sending an unchanged field
    // would lock it in human_locked_fields even though the user never
    // touched it, permanently blocking Helena from updating it.
    if (newValue !== currentValue) {
      patch[f.key] = newValue;
    }
  }
  return patch;
}

interface QualificationSectionProps {
  title: string;
  fields: QualificationFieldDescriptor[];
  values: Record<string, unknown>;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  truncateSummary?: boolean;
  hideTitle?: boolean;
  emptyFallback?: string;
  startInEditMode?: boolean;
}

export function QualificationSection({
  title,
  fields,
  values,
  onSave,
  truncateSummary = false,
  hideTitle = false,
  emptyFallback,
  startInEditMode = false,
}: QualificationSectionProps) {
  const [editing, setEditing] = useState(startInEditMode);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    if (!startInEditMode) return {};
    const initial: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.key];
      initial[f.key] = v === null || v === undefined ? "" : String(v);
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);

  const startEditing = () => {
    const initial: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.key];
      initial[f.key] = v === null || v === undefined ? "" : String(v);
    }
    setDraft(initial);
    setEditing(true);
  };

  const handleSave = async () => {
    const patch = draftToPatch(fields, draft, values);
    if (Object.keys(patch).length === 0) {
      // Nothing actually changed — skip the API call entirely rather than
      // sending an empty patch (which would be a no-op write anyway).
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(patch);
      setEditing(false);
    } catch (err) {
      // Deliberately does NOT setEditing(false) or clear `draft` here — the
      // spec requires a failed save to keep whatever the user typed on
      // screen, not silently discard it.
      alert(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className={hideTitle ? "mb-2 flex items-center justify-end" : "mb-2 flex items-center justify-between"}>
        {!hideTitle && <h3 className="text-sm font-semibold">{title}</h3>}
        {!editing && (
          <Button variant="ghost" size="icon-sm" onClick={startEditing}>
            <Pencil className="size-3.5" />
          </Button>
        )}
      </div>

      {!editing ? (
        <div className="space-y-3">
          {(() => {
            const visibleFields = fields.filter((f) => !f.hideInView && hasValue(values[f.key]));
            if (visibleFields.length === 0) {
              return emptyFallback ? <p className="text-sm text-muted-foreground italic">{emptyFallback}</p> : null;
            }
            const emphasized = visibleFields.filter((f) => f.emphasize);
            const regular = visibleFields.filter((f) => !f.emphasize);
            return (
              <>
                {emphasized.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {emphasized.map((f) => (
                      <div key={f.key} className="rounded-md border bg-muted/30 p-2">
                        <p className="text-lg font-semibold">{formatReadValue(f, values[f.key])}</p>
                        <p className="text-xs text-muted-foreground">{f.label}</p>
                      </div>
                    ))}
                  </div>
                )}
                {regular.length > 0 && (
                  <div>
                    {regular.map((f) => {
                      const display = formatReadValue(f, values[f.key]);
                      if (truncateSummary && f.kind === "textarea" && display) {
                        return <TruncatedText key={f.key} text={display} />;
                      }
                      return (
                        <div key={f.key} className="flex items-center justify-between gap-4 py-1 text-sm">
                          <span className="text-muted-foreground">{f.label}</span>
                          <span className="font-medium">{display}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className="text-xs text-muted-foreground">{f.label}</label>
              {f.kind === "textarea" ? (
                <Textarea
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  rows={3}
                />
              ) : f.kind === "select" || f.kind === "boolean" ? (
                <select
                  className="w-full rounded-md border px-2 py-1 text-sm"
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                >
                  <option value="">Não informado</option>
                  {f.kind === "boolean"
                    ? [
                        { value: "true", label: "Sim" },
                        { value: "false", label: "Não" },
                      ].map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))
                    : f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                </select>
              ) : (
                <Input
                  type={f.kind === "number" || f.kind === "currency" ? "number" : f.kind === "date" ? "date" : "text"}
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Salvando..." : "Salvar"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
