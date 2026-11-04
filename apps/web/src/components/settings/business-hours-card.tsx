"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  calendarFromForm, formFromCalendar, validateBusinessHoursForm, NATIONAL_HOLIDAYS_2026_2027,
  type BusinessHoursForm,
} from "@aula-agente/shared";

const fmtDate = (iso: string) => iso.split("-").reverse().join("/");

export function BusinessHoursCard({ orgId, calendar, isManager, onSaved }: { orgId: string; calendar: unknown; isManager: boolean; onSaved: () => Promise<unknown> | void }) {
  const [form, setForm] = useState<BusinessHoursForm>(() => formFromCalendar(calendar));
  const [newDate, setNewDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const configured = !!calendar && typeof calendar === "object";

  useEffect(() => { setForm(formFromCalendar(calendar)); }, [calendar]);

  const patch = (p: Partial<BusinessHoursForm>) => { setSaved(false); setForm(f => ({ ...f, ...p })); };
  const addDates = (dates: string[]) => patch({ closedDates: [...new Set([...form.closedDates, ...dates])].sort() });

  async function save() {
    const invalid = validateBusinessHoursForm(form);
    if (invalid) { setError(invalid); return; }
    setSaving(true); setError(null);
    try {
      const client = createClient();
      const { data: org, error: readError } = await client.from("organizations").select("settings").eq("id", orgId).single();
      if (readError) throw readError;
      const next = { ...org.settings, business_calendar: calendarFromForm(form, org.settings?.business_calendar) };
      let query = client.from("organizations").update({ settings: next }).eq("id", orgId);
      query = org.settings == null ? query.is("settings", null) : query.eq("settings", JSON.stringify(org.settings));
      const { data, error: writeError } = await query.select("id").maybeSingle();
      if (writeError) throw writeError;
      if (!data) throw new Error("As configurações mudaram. Atualize a página e tente novamente.");
      await onSaved(); setSaved(true);
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Horário comercial e feriados</CardTitle>
        <CardDescription>Define quando a loja atende. O prazo para o vendedor assumir o lead, o aviso &quot;fora do horário&quot; da IA e os alertas de lead sem resposta só contam dentro deste horário.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!configured && <p className="text-sm text-amber-600">Nenhum horário salvo: o sistema usa segunda a sexta, 08:00–18:00, sem sábado nem feriados. Salve abaixo para valer o horário da loja.</p>}
        <div className="flex flex-wrap items-end gap-3">
          <span className="w-32 text-sm font-medium">Segunda a sexta</span>
          <div className="space-y-1"><Label htmlFor="wd-start">Abre</Label><Input id="wd-start" type="time" className="w-32" disabled={!isManager} value={form.weekdayStart} onChange={e => patch({ weekdayStart: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="wd-end">Fecha</Label><Input id="wd-end" type="time" className="w-32" disabled={!isManager} value={form.weekdayEnd} onChange={e => patch({ weekdayEnd: e.target.value })} /></div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <span className="w-32 text-sm font-medium">Sábado</span>
          <div className="flex items-center gap-2 pb-2"><Switch id="sat-open" aria-label="Abre aos sábados" disabled={!isManager} checked={form.saturdayOpen} onCheckedChange={v => patch({ saturdayOpen: v })} /><Label htmlFor="sat-open">Abre</Label></div>
          {form.saturdayOpen && <>
            <div className="space-y-1"><Label htmlFor="sat-start">Das</Label><Input id="sat-start" type="time" className="w-32" disabled={!isManager} value={form.saturdayStart} onChange={e => patch({ saturdayStart: e.target.value })} /></div>
            <div className="space-y-1"><Label htmlFor="sat-end">Até</Label><Input id="sat-end" type="time" className="w-32" disabled={!isManager} value={form.saturdayEnd} onChange={e => patch({ saturdayEnd: e.target.value })} /></div>
          </>}
        </div>
        <p className="text-xs text-muted-foreground">Domingo fica sempre fechado.</p>
        <div className="space-y-2">
          <p className="text-sm font-medium">Dias fechados (feriados)</p>
          {!form.closedDates.length && <p className="text-sm text-muted-foreground">Nenhum feriado cadastrado.</p>}
          <div className="flex flex-wrap gap-2">
            {form.closedDates.map(d => (
              <span key={d} className="inline-flex items-center gap-1 rounded border px-2 py-1 text-sm">{fmtDate(d)}
                {isManager && <button type="button" aria-label={`Remover ${fmtDate(d)}`} className="text-muted-foreground hover:text-destructive" onClick={() => patch({ closedDates: form.closedDates.filter(x => x !== d) })}>×</button>}
              </span>
            ))}
          </div>
          {isManager && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1"><Label htmlFor="new-holiday">Adicionar dia fechado</Label><Input id="new-holiday" type="date" className="w-44" value={newDate} onChange={e => setNewDate(e.target.value)} /></div>
              <Button type="button" size="sm" variant="outline" disabled={!newDate} onClick={() => { addDates([newDate]); setNewDate(""); }}>Adicionar</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => addDates(NATIONAL_HOLIDAYS_2026_2027)}>Incluir feriados nacionais (nov/2026 a jan/2027)</Button>
            </div>
          )}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {saved && <p role="status" className="text-sm text-green-600">Horário salvo.</p>}
        {isManager ? <Button onClick={save} disabled={saving}>{saving ? "Salvando…" : "Salvar horário"}</Button>
          : <p className="text-xs text-muted-foreground">Só gerentes podem alterar o horário comercial.</p>}
      </CardContent>
    </Card>
  );
}
