"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrencyBRL } from "@/lib/utils";

export type QualificationFieldDescriptor =
  | { key: string; label: string; kind: "text" }
  | { key: string; label: string; kind: "textarea" }
  | { key: string; label: string; kind: "number" }
  | { key: string; label: string; kind: "currency" }
  | { key: string; label: string; kind: "date" }
  | { key: string; label: string; kind: "boolean" }
  | { key: string; label: string; kind: "select"; options: Array<{ value: string; label: string }> };

function formatReadValue(field: QualificationFieldDescriptor, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (field.kind === "currency") return formatCurrencyBRL(value as number);
  if (field.kind === "boolean") return value === true ? "Sim" : "Não";
  if (field.kind === "date") return new Date(`${value}T00:00:00`).toLocaleDateString("pt-BR");
  if (field.kind === "select") return field.options.find((o) => o.value === value)?.label ?? String(value);
  return String(value);
}

function draftToPatch(fields: QualificationFieldDescriptor[], draft: Record<string, string>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = draft[f.key] ?? "";
    if (f.kind === "number" || f.kind === "currency") {
      patch[f.key] = raw === "" ? null : Number(raw);
    } else if (f.kind === "boolean") {
      patch[f.key] = raw === "" ? null : raw === "true";
    } else {
      patch[f.key] = raw === "" ? null : raw;
    }
  }
  return patch;
}

interface QualificationSectionProps {
  title: string;
  fields: QualificationFieldDescriptor[];
  values: Record<string, unknown>;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}

export function QualificationSection({ title, fields, values, onSave }: QualificationSectionProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
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
    setSaving(true);
    try {
      await onSave(draftToPatch(fields, draft));
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
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={startEditing}>
            Editar
          </Button>
        )}
      </div>

      {!editing ? (
        <div>
          {fields.map((f) => {
            const display = formatReadValue(f, values[f.key]);
            return (
              <div key={f.key} className="flex items-center justify-between gap-4 py-1 text-sm">
                <span className="text-muted-foreground">{f.label}</span>
                <span className={display ? "font-medium" : "text-muted-foreground italic"}>
                  {display ?? "Não informado"}
                </span>
              </div>
            );
          })}
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
