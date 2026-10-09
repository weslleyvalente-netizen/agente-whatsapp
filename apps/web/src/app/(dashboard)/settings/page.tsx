"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eye, EyeOff, Save, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { LLMProvider, IgnoredContactRetentionMode, OrganizationIgnoredContact, SalesRep, SalesRepAvailability } from "@aula-agente/shared";
import { useMyRole } from "@/components/lead-distribution/use-my-role";
import {
  DEFAULT_HUMAN_TAKEOVER_TIMEOUT_MINUTES,
  DEFAULT_HANDOFF_UNANSWERED_ALERT_MINUTES,
  DEFAULT_GREETING_FILTER_ENABLED,
  DEFAULT_GREETING_WORDS,
  DEFAULT_GREETING_MAX_LENGTH,
  DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG,
  DEFAULT_TASK_FOLLOWUP_CONFIG,
  DEFAULT_AD_CLOSING_MESSAGE,
  validateClosingSettings,
} from "@aula-agente/shared";

interface MemberOption {
  user_id: string;
  email: string;
  role: string;
}

const PROVIDERS: { id: LLMProvider; name: string; placeholder: string }[] = [
  { id: "openai", name: "OpenAI", placeholder: "sk-..." },
  { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-..." },
  { id: "google", name: "Google AI", placeholder: "AI..." },
];

export default function SettingsPage() {
  const { currentOrg, refetch } = useOrganization();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [savingKeys, setSavingKeys] = useState(false);
  const [takeoverEnabled, setTakeoverEnabled] = useState(true);
  const [takeoverMinutes, setTakeoverMinutes] = useState(String(DEFAULT_HUMAN_TAKEOVER_TIMEOUT_MINUTES));
  const [savingTakeover, setSavingTakeover] = useState(false);

  // Fase 1 — handoff explícito
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [defaultAssigneeId, setDefaultAssigneeId] = useState<string>("none");
  const [notificationPhone, setNotificationPhone] = useState("");
  const [alertMinutes, setAlertMinutes] = useState(String(DEFAULT_HANDOFF_UNANSWERED_ALERT_MINUTES));
  const [savingHandoff, setSavingHandoff] = useState(false);

  // Fase 1 — saudação não é takeover
  const [greetingEnabled, setGreetingEnabled] = useState(DEFAULT_GREETING_FILTER_ENABLED);
  const [greetingWords, setGreetingWords] = useState(DEFAULT_GREETING_WORDS.join(", "));
  const [greetingMaxLength, setGreetingMaxLength] = useState(String(DEFAULT_GREETING_MAX_LENGTH));
  const [savingGreeting, setSavingGreeting] = useState(false);

  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [leadError, setLeadError] = useState<string | null>(null);

  async function toggleWorkspace(enabled: boolean, flag: "sales_workspace_enabled" | "sales_low_intent_cadence_enabled" | "sales_auto_pipeline_enabled" | "sales_opportunity_freeze_enabled" | "sales_action_queue_enabled" | "sales_qualified_handoff_task_enabled" | "scheduled_ad_closure_enabled" | "silence_task_auto_retire_enabled" | "lead_distribution_enabled" | "lead_distribution_shadow_enabled" | "seller_isolation_enabled" = "sales_workspace_enabled") {
    if (!currentOrg || savingWorkspace) return;
    const isLead = flag.startsWith("lead_distribution") || flag === "seller_isolation_enabled";
    const setErr = isLead ? setLeadError : setWorkspaceError;
    setSavingWorkspace(true); setErr(null);
    try {
      const client = createClient();
      const { data: org, error: readError } = await client.from("organizations").select("settings").eq("id", currentOrg.id).single();
      if (readError) throw readError;
      let query = client.from("organizations").update({ settings: { ...org.settings, [flag]: enabled, ...(flag === "sales_low_intent_cadence_enabled" && enabled ? { sales_low_intent_cadence_started_at: new Date().toISOString() } : {}), ...(flag === "lead_distribution_enabled" && enabled ? { lead_distribution_activated_at: new Date().toISOString() } : {}) } }).eq("id", currentOrg.id);
      query = org.settings == null ? query.is("settings", null) : query.eq("settings", JSON.stringify(org.settings));
      const { data, error } = await query.select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("As configurações mudaram. Atualize a página e tente novamente.");
      await refetch();
    } catch (err) { setErr((err as Error).message); } finally { setSavingWorkspace(false); }
  }


  // Distribuição de leads (rodízio entre vendedores)
  const { role: myRole } = useMyRole();
  const isManager = myRole === "owner" || myRole === "admin";
  const [slaMinutes, setSlaMinutes] = useState("15");
  const [savingSla, setSavingSla] = useState(false);
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [repsError, setRepsError] = useState<string | null>(null);
  useEffect(() => {
    setSlaMinutes(String(currentOrg?.settings.lead_sla_minutes ?? 15));
  }, [currentOrg?.id, currentOrg?.settings.lead_sla_minutes]);
  useEffect(() => {
    if (!currentOrg || currentOrg.settings.lead_distribution_enabled !== true) { setReps([]); return; }
    apiFetch(`/organizations/${currentOrg.id}/sales-reps`).then((r: SalesRep[]) => setReps(r)).catch(() => setReps([]));
  }, [currentOrg]);

  async function saveSlaMinutes() {
    if (!currentOrg || savingSla) return;
    const minutes = Number(slaMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) { setLeadError("O prazo de resposta deve ser um número inteiro entre 5 e 240 minutos."); return; }
    setSavingSla(true); setLeadError(null);
    try {
      const client = createClient();
      const { data: org, error: readError } = await client.from("organizations").select("settings").eq("id", currentOrg.id).single();
      if (readError) throw readError;
      let query = client.from("organizations").update({ settings: { ...org.settings, lead_sla_minutes: minutes } }).eq("id", currentOrg.id);
      query = org.settings == null ? query.is("settings", null) : query.eq("settings", JSON.stringify(org.settings));
      const { data, error } = await query.select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("As configurações mudaram. Atualize a página e tente novamente.");
      await refetch();
    } catch (err) { setLeadError((err as Error).message); } finally { setSavingSla(false); }
  }

  async function changeRepAvailability(rep: SalesRep, availability: SalesRepAvailability) {
    if (!currentOrg) return;
    setRepsError(null);
    try {
      const updated: SalesRep = await apiFetch(`/organizations/${currentOrg.id}/sales-reps/${rep.id}/availability`, { method: "PATCH", body: JSON.stringify({ availability }) });
      setReps(prev => prev.map(r => r.id === rep.id ? updated : r));
    } catch (err) { setRepsError((err as Error).message); }
  }

  // Fase 2 — triagem de tarefas
  const [taskAutoLinkEnabled, setTaskAutoLinkEnabled] = useState(false);
  const [taskConsolidationEnabled, setTaskConsolidationEnabled] = useState(false);
  const [taskAutoCloseEnabled, setTaskAutoCloseEnabled] = useState(false);
  const [liberaCredEnabled, setLiberaCredEnabled] = useState(false);
  const [liberaCredWindowDays, setLiberaCredWindowDays] = useState(
    String(DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.window_days)
  );
  const [liberaCredTableMaxAgeDays, setLiberaCredTableMaxAgeDays] = useState(
    String(DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.table_max_age_days)
  );
  const [liberaCredDailyLimit, setLiberaCredDailyLimit] = useState(
    String(DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.daily_limit)
  );
  const [savingFase2, setSavingFase2] = useState(false);

  const [closingMessage,setClosingMessage]=useState(DEFAULT_AD_CLOSING_MESSAGE);
  const [closingHours,setClosingHours]=useState("1");
  const [savingClosing,setSavingClosing]=useState(false);
  const [closingError,setClosingError]=useState<string|null>(null);
  const saveClosingSettings=async()=>{
    if(!currentOrg || savingClosing)return;
    setSavingClosing(true);setClosingError(null);
    try{
      const validated=validateClosingSettings(closingMessage,closingHours);
      const client=createClient();
      const {data:org,error:readError}=await client.from("organizations").select("settings").eq("id",currentOrg.id).single();
      if(readError)throw readError;
      let q=client.from("organizations").update({settings:{...org.settings,sales_low_intent_closing_message:validated.message,sales_low_intent_final_delay_hours:validated.delayHours}}).eq("id",currentOrg.id);
      q=org.settings==null?q.is("settings",null):q.eq("settings",JSON.stringify(org.settings));
      const {data,error}=await q.select("id").maybeSingle();
      if(error)throw error;if(!data)throw new Error("As configurações mudaram. Atualize e tente novamente.");
      await refetch();
    }catch(error){setClosingError((error as Error).message);}finally{setSavingClosing(false);}
  };

  // Follow-up direto da tarefa
  const [followupEnabled, setFollowupEnabled] = useState(false);
  const [followupTakeoverOnSend, setFollowupTakeoverOnSend] = useState(
    DEFAULT_TASK_FOLLOWUP_CONFIG.takeover_on_send
  );
  const [followupMinInterval, setFollowupMinInterval] = useState(
    String(DEFAULT_TASK_FOLLOWUP_CONFIG.min_interval_seconds)
  );
  const [followupDailyLimit, setFollowupDailyLimit] = useState(String(DEFAULT_TASK_FOLLOWUP_CONFIG.daily_limit));
  const [followupMaxRegenerations, setFollowupMaxRegenerations] = useState(
    String(DEFAULT_TASK_FOLLOWUP_CONFIG.max_regenerations)
  );
  const [savingFollowup, setSavingFollowup] = useState(false);

  // Fase 1 — contatos ignorados
  const [ignoredContacts, setIgnoredContacts] = useState<OrganizationIgnoredContact[]>([]);
  const [newIgnoredPhone, setNewIgnoredPhone] = useState("");
  const [newIgnoredLabel, setNewIgnoredLabel] = useState("");
  const [newIgnoredMode, setNewIgnoredMode] = useState<IgnoredContactRetentionMode>("no_store");
  const [savingIgnored, setSavingIgnored] = useState(false);

  const fetchIgnoredContacts = useCallback(async () => {
    if (!currentOrg) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("organization_ignored_contacts")
      .select("*")
      .eq("organization_id", currentOrg.id)
      .order("created_at", { ascending: false });
    setIgnoredContacts((data as OrganizationIgnoredContact[] | null) || []);
  }, [currentOrg]);

  useEffect(() => {
    if (!currentOrg) return;
    setName(currentOrg.name);
    fetchApiKeys();
    fetchIgnoredContacts();

    const configured = currentOrg.settings.human_takeover_timeout_minutes;
    setTakeoverEnabled(configured !== null);
    setTakeoverMinutes(String(configured ?? DEFAULT_HUMAN_TAKEOVER_TIMEOUT_MINUTES));

    setDefaultAssigneeId(currentOrg.settings.default_handoff_assignee_id ?? "none");
    setNotificationPhone(currentOrg.settings.handoff_notification_phone ?? "");
    setAlertMinutes(String(currentOrg.settings.handoff_unanswered_alert_minutes ?? DEFAULT_HANDOFF_UNANSWERED_ALERT_MINUTES));

    setGreetingEnabled(currentOrg.settings.takeover_greeting_filter_enabled ?? DEFAULT_GREETING_FILTER_ENABLED);
    setGreetingWords((currentOrg.settings.takeover_greeting_words ?? DEFAULT_GREETING_WORDS).join(", "));
    setGreetingMaxLength(String(currentOrg.settings.takeover_greeting_max_length ?? DEFAULT_GREETING_MAX_LENGTH));

    setTaskAutoLinkEnabled(currentOrg.settings.task_auto_link_opportunity_enabled ?? false);
    setTaskConsolidationEnabled(currentOrg.settings.task_consolidation_by_opportunity_enabled ?? false);
    setTaskAutoCloseEnabled(currentOrg.settings.task_auto_close_awaiting_customer_enabled ?? false);
    setLiberaCredEnabled(currentOrg.settings.libera_cred_resumption_enabled ?? false);
    setLiberaCredWindowDays(
      String(currentOrg.settings.libera_cred_resumption_window_days ?? DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.window_days)
    );
    setLiberaCredTableMaxAgeDays(
      String(currentOrg.settings.libera_cred_table_max_age_days ?? DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.table_max_age_days)
    );
    setLiberaCredDailyLimit(
      String(currentOrg.settings.libera_cred_resumption_daily_limit ?? DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.daily_limit)
    );

    setClosingMessage(currentOrg.settings.sales_low_intent_closing_message ?? DEFAULT_AD_CLOSING_MESSAGE);
    setClosingHours(String(currentOrg.settings.sales_low_intent_final_delay_hours ?? 1));
    setFollowupEnabled(currentOrg.settings.task_followup_enabled ?? false);
    setFollowupTakeoverOnSend(
      currentOrg.settings.task_followup_takeover_on_send ?? DEFAULT_TASK_FOLLOWUP_CONFIG.takeover_on_send
    );
    setFollowupMinInterval(
      String(currentOrg.settings.task_followup_min_interval_seconds ?? DEFAULT_TASK_FOLLOWUP_CONFIG.min_interval_seconds)
    );
    setFollowupDailyLimit(
      String(currentOrg.settings.task_followup_daily_limit ?? DEFAULT_TASK_FOLLOWUP_CONFIG.daily_limit)
    );
    setFollowupMaxRegenerations(
      String(currentOrg.settings.task_followup_max_regenerations ?? DEFAULT_TASK_FOLLOWUP_CONFIG.max_regenerations)
    );

    apiFetch(`/organizations/${currentOrg.id}/members/display`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [currentOrg, fetchIgnoredContacts]);

  const fetchApiKeys = async () => {
    if (!currentOrg) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("organization_secrets")
      .select("provider, encrypted_key")
      .eq("organization_id", currentOrg.id);

    const keys: Record<string, string> = {};
    (data || []).forEach((s: any) => {
      keys[s.provider] = s.encrypted_key;
    });
    setApiKeys(keys);
  };

  const handleSaveName = async () => {
    if (!currentOrg || !name) return;
    setSaving(true);

    const supabase = createClient();
    await supabase.from("organizations").update({ name }).eq("id", currentOrg.id);

    await refetch();
    setSaving(false);
  };

  const handleSaveApiKey = async (provider: LLMProvider) => {
    if (!currentOrg) return;
    setSavingKeys(true);

    const supabase = createClient();
    const key = apiKeys[provider];

    if (!key) {
      // Delete existing
      await supabase
        .from("organization_secrets")
        .delete()
        .eq("organization_id", currentOrg.id)
        .eq("provider", provider);
    } else {
      // Upsert
      await supabase
        .from("organization_secrets")
        .upsert(
          {
            organization_id: currentOrg.id,
            provider,
            encrypted_key: key,
          },
          { onConflict: "organization_id,provider" }
        );
    }

    setSavingKeys(false);
  };

  const handleSaveTakeoverSettings = async () => {
    if (!currentOrg) return;
    setSavingTakeover(true);

    const supabase = createClient();
    const minutes = takeoverEnabled ? Math.max(1, Number(takeoverMinutes) || DEFAULT_HUMAN_TAKEOVER_TIMEOUT_MINUTES) : null;

    await supabase
      .from("organizations")
      .update({
        settings: { ...currentOrg.settings, human_takeover_timeout_minutes: minutes },
      })
      .eq("id", currentOrg.id);

    await refetch();
    setSavingTakeover(false);
  };

  const handleSaveHandoffSettings = async () => {
    if (!currentOrg) return;
    setSavingHandoff(true);

    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({
        settings: {
          ...currentOrg.settings,
          default_handoff_assignee_id: defaultAssigneeId === "none" ? null : defaultAssigneeId,
          handoff_notification_phone: notificationPhone.trim() || null,
          handoff_unanswered_alert_minutes: Math.max(1, Number(alertMinutes) || DEFAULT_HANDOFF_UNANSWERED_ALERT_MINUTES),
        },
      })
      .eq("id", currentOrg.id);

    await refetch();
    setSavingHandoff(false);
  };

  const handleSaveFase2Settings = async () => {
    if (!currentOrg) return;
    setSavingFase2(true);

    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({
        settings: {
          ...currentOrg.settings,
          task_auto_link_opportunity_enabled: taskAutoLinkEnabled,
          task_consolidation_by_opportunity_enabled: taskConsolidationEnabled,
          task_auto_close_awaiting_customer_enabled: taskAutoCloseEnabled,
          libera_cred_resumption_enabled: liberaCredEnabled,
          libera_cred_resumption_window_days: Math.max(
            1,
            Number(liberaCredWindowDays) || DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.window_days
          ),
          libera_cred_table_max_age_days: Math.max(
            1,
            Number(liberaCredTableMaxAgeDays) || DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.table_max_age_days
          ),
          libera_cred_resumption_daily_limit: Math.max(
            1,
            Number(liberaCredDailyLimit) || DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG.daily_limit
          ),
        },
      })
      .eq("id", currentOrg.id);

    await refetch();
    setSavingFase2(false);
  };

  const handleSaveFollowupSettings = async () => {
    if (!currentOrg) return;
    setSavingFollowup(true);

    setClosingError(null);
    try {
    const supabase = createClient();
    const {data:latest,error:readError}=await supabase.from("organizations").select("settings").eq("id",currentOrg.id).single();
    if(readError)throw readError;
    let query=supabase
      .from("organizations")
      .update({
        settings: {
          ...latest.settings,
          task_followup_enabled: followupEnabled,
          task_followup_takeover_on_send: followupTakeoverOnSend,
          task_followup_min_interval_seconds: Math.max(
            1,
            Number(followupMinInterval) || DEFAULT_TASK_FOLLOWUP_CONFIG.min_interval_seconds
          ),
          task_followup_daily_limit: Math.max(
            1,
            Number(followupDailyLimit) || DEFAULT_TASK_FOLLOWUP_CONFIG.daily_limit
          ),
          task_followup_max_regenerations: Math.max(
            1,
            Number(followupMaxRegenerations) || DEFAULT_TASK_FOLLOWUP_CONFIG.max_regenerations
          ),
        },
      })
      .eq("id", currentOrg.id);
    query=latest.settings==null?query.is("settings",null):query.eq("settings",JSON.stringify(latest.settings));
    const {data,error}=await query.select("id").maybeSingle();
    if(error)throw error;if(!data)throw new Error("As configurações mudaram. Atualize e tente novamente.");

    await refetch();
    }catch(error){setClosingError((error as Error).message);}finally{setSavingFollowup(false);}
  };

  const handleSaveGreetingSettings = async () => {
    if (!currentOrg) return;
    setSavingGreeting(true);

    const supabase = createClient();
    const words = greetingWords
      .split(",")
      .map((w) => w.trim())
      .filter((w) => w.length > 0);

    await supabase
      .from("organizations")
      .update({
        settings: {
          ...currentOrg.settings,
          takeover_greeting_filter_enabled: greetingEnabled,
          takeover_greeting_words: words.length > 0 ? words : DEFAULT_GREETING_WORDS,
          takeover_greeting_max_length: Math.max(1, Number(greetingMaxLength) || DEFAULT_GREETING_MAX_LENGTH),
        },
      })
      .eq("id", currentOrg.id);

    await refetch();
    setSavingGreeting(false);
  };

  const handleAddIgnoredContact = async () => {
    if (!currentOrg || !newIgnoredPhone.trim()) return;
    setSavingIgnored(true);

    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();
    await supabase.from("organization_ignored_contacts").insert({
      organization_id: currentOrg.id,
      phone: newIgnoredPhone.replace(/\D/g, ""),
      label: newIgnoredLabel.trim() || null,
      retention_mode: newIgnoredMode,
      created_by: userData.user?.id ?? null,
    });

    setNewIgnoredPhone("");
    setNewIgnoredLabel("");
    setNewIgnoredMode("no_store");
    await fetchIgnoredContacts();
    setSavingIgnored(false);
  };

  const handleDeleteIgnoredContact = async (id: string) => {
    const supabase = createClient();
    await supabase.from("organization_ignored_contacts").delete().eq("id", id);
    await fetchIgnoredContacts();
  };

  if (!currentOrg) return <div>Carregando...</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Configuracoes</h1>

      <Card>
        <CardHeader>
          <CardTitle>Organizacao</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Nome</Label>
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
              <Button onClick={handleSaveName} disabled={saving}>
                <Save className="mr-2 h-4 w-4" />
                {saving ? "Salvando..." : "Salvar"}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Slug</Label>
            <Input value={currentOrg.slug} disabled />
          </div>

          <div className="space-y-2">
            <Label>Plano</Label>
            <Badge>{currentOrg.plan}</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API Keys dos Providers</CardTitle>
          <CardDescription>
            Configure as chaves de API para cada provider de LLM. Se nao configurado, sera
            usado o fallback global da plataforma.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {PROVIDERS.map((provider) => (
            <div key={provider.id} className="space-y-2">
              <Label>{provider.name}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type={showKeys[provider.id] ? "text" : "password"}
                    value={apiKeys[provider.id] || ""}
                    onChange={(e) =>
                      setApiKeys((prev) => ({ ...prev, [provider.id]: e.target.value }))
                    }
                    placeholder={provider.placeholder}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setShowKeys((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))
                    }
                    className="absolute right-2 top-2.5 text-muted-foreground"
                  >
                    {showKeys[provider.id] ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={() => handleSaveApiKey(provider.id)}
                  disabled={savingKeys}
                >
                  Salvar
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Retomada automática da IA</CardTitle>
          <CardDescription>
            Quando um humano assume uma conversa manualmente, a IA para de responder. Por
            padrão, ela retoma sozinha depois de um tempo sem atividade humana registrada no
            sistema. Ajuste esse tempo ou desligue a retomada automática por completo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="takeover-enabled">Retomada automática ativada</Label>
            <Switch id="takeover-enabled" checked={takeoverEnabled} onCheckedChange={setTakeoverEnabled} />
          </div>

          <div className="space-y-2">
            <Label>Tempo até a IA retomar (minutos)</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                value={takeoverMinutes}
                onChange={(e) => setTakeoverMinutes(e.target.value)}
                disabled={!takeoverEnabled}
              />
              <Button onClick={handleSaveTakeoverSettings} disabled={savingTakeover}>
                <Save className="mr-2 h-4 w-4" />
                {savingTakeover ? "Salvando..." : "Salvar"}
              </Button>
            </div>
            {!takeoverEnabled && (
              <p className="text-sm text-muted-foreground">
                Com a retomada desligada, a conversa só volta para a IA quando alguém clicar em
                "Devolver ao Agente".
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Handoff explícito</CardTitle>
          <CardDescription>
            Quando a Helena aciona a ferramenta "requestHuman" (Fase 1), a conversa é
            atribuída à responsável padrão abaixo e, opcionalmente, um número interno é
            avisado por WhatsApp. Diferente da retomada automática, esse tipo de handoff não
            volta sozinho para a IA — se ninguém responder dentro do prazo configurado, um
            alerta de "handoff sem resposta" aparece no card da tela Início.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Responsável padrão pelo handoff</Label>
            <Select value={defaultAssigneeId} onValueChange={(v) => setDefaultAssigneeId(v ?? "none")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nenhuma (atribuir manualmente depois)</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Número interno para notificação (opcional)</Label>
            <Input
              value={notificationPhone}
              onChange={(e) => setNotificationPhone(e.target.value)}
              placeholder="Ex.: 5511999998888"
            />
          </div>

          <div className="space-y-2">
            <Label>Alerta de "handoff sem resposta" após (minutos)</Label>
            <Input
              type="number"
              min={1}
              value={alertMinutes}
              onChange={(e) => setAlertMinutes(e.target.value)}
            />
          </div>

          <Button onClick={handleSaveHandoffSettings} disabled={savingHandoff}>
            <Save className="mr-2 h-4 w-4" />
            {savingHandoff ? "Salvando..." : "Salvar"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Saudação não ativa takeover</CardTitle>
          <CardDescription>
            Uma mensagem curta mandada direto do celular conectado (ex.: "Bom dia") não
            assume a conversa sozinha — ela fica registrada e visível no histórico, mas a IA
            continua respondendo o cliente normalmente. Só uma mensagem com conteúdo real
            ativa o handoff.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="greeting-enabled">Filtro de saudação ativado</Label>
            <Switch id="greeting-enabled" checked={greetingEnabled} onCheckedChange={setGreetingEnabled} />
          </div>

          <div className="space-y-2">
            <Label>Palavras consideradas saudação/confirmação (separadas por vírgula)</Label>
            <Textarea
              value={greetingWords}
              onChange={(e) => setGreetingWords(e.target.value)}
              disabled={!greetingEnabled}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label>Limite de caracteres</Label>
            <Input
              type="number"
              min={1}
              value={greetingMaxLength}
              onChange={(e) => setGreetingMaxLength(e.target.value)}
              disabled={!greetingEnabled}
            />
            <p className="text-sm text-muted-foreground">
              Só conta como saudação uma palavra da lista acima dentro desse limite (ou uma
              mensagem só com emoji) — uma frase real nunca é filtrada, mesmo que comece com
              "Bom dia".
            </p>
          </div>

          <Button onClick={handleSaveGreetingSettings} disabled={savingGreeting}>
            <Save className="mr-2 h-4 w-4" />
            {savingGreeting ? "Salvando..." : "Salvar"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Distribuição</CardTitle><CardDescription>Rodízio de novos leads entre os vendedores, com prazo de resposta.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
  <Label htmlFor="seller-isolation">Isolamento por vendedor (cada vendedor só vê o que é dele e o que está sem dono)</Label>
  <Switch id="seller-isolation" checked={currentOrg?.settings.seller_isolation_enabled === true} disabled={savingWorkspace} onCheckedChange={v => toggleWorkspace(v, "seller_isolation_enabled")} />
</div>
          <div className="flex items-center justify-between gap-3"><Label htmlFor="lead-dist-shadow">Modo de teste (simulação)</Label><Switch id="lead-dist-shadow" checked={currentOrg?.settings.lead_distribution_shadow_enabled === true} disabled={savingWorkspace} onCheckedChange={v => toggleWorkspace(v, "lead_distribution_shadow_enabled")}/></div>
          <p className="text-xs text-muted-foreground">Calcula quem receberia cada lead e registra, sem alterar nada. Use antes de ativar.</p>
          <div className="flex items-center justify-between gap-3"><Label htmlFor="lead-dist-enabled">Distribuição de leads ativa</Label><Switch id="lead-dist-enabled" checked={currentOrg?.settings.lead_distribution_enabled === true} disabled={savingWorkspace} onCheckedChange={v => toggleWorkspace(v, "lead_distribution_enabled")}/></div>
          <div className="flex items-end gap-3"><div className="space-y-1"><Label htmlFor="lead-sla-minutes">Prazo para o vendedor assumir (minutos)</Label><Input id="lead-sla-minutes" type="number" min={5} max={240} className="w-32" value={slaMinutes} onChange={e => setSlaMinutes(e.target.value)}/></div><Button size="sm" disabled={savingSla} onClick={saveSlaMinutes}>Salvar prazo</Button></div>
          {currentOrg?.settings.lead_distribution_enabled === true && (
            <div className="space-y-2" aria-label="Vendedores">
              <p className="text-sm font-medium">Vendedores</p>
              {!reps.length && <p className="text-sm text-muted-foreground">Nenhum vendedor cadastrado.</p>}
              {reps.map(r => (
                <div key={r.id} className="flex items-center justify-between gap-3 text-sm">
                  <span>{r.display_name}</span>
                  {isManager
                    ? <select aria-label={`Estado de ${r.display_name}`} className="rounded border bg-background p-1" value={r.availability} onChange={e => changeRepAvailability(r, e.target.value as SalesRepAvailability)}><option value="available">Disponível</option><option value="paused">Pausado</option><option value="out">Fora da distribuição</option></select>
                    : <span className="text-muted-foreground">{r.availability === "available" ? "Disponível" : r.availability === "paused" ? "Pausado" : "Fora da distribuição"}</span>}
                </div>
              ))}
              {repsError && <p role="alert" className="text-sm text-destructive">{repsError}</p>}
            </div>
          )}
          {leadError && <p role="alert" className="text-sm text-destructive">{leadError}</p>}
          <p className="text-xs text-muted-foreground">O calendário comercial padrão é segunda a sexta, 08:00–18:00. Para atender aos sábados, configure <code>business_calendar</code> (janela de sábado).</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Operação no funil de vendas</CardTitle><CardDescription>Encaminhamentos da IA, indicadores nos leads, conversa e tarefas dentro do negócio.</CardDescription></CardHeader>
        <CardContent className="space-y-3"><div className="flex items-center justify-between gap-3"><Label htmlFor="sales-queue">Fila de atendimento no funil</Label><Switch id="sales-queue" checked={currentOrg?.settings.sales_action_queue_enabled===true} disabled={savingWorkspace} onCheckedChange={v=>toggleWorkspace(v,"sales_action_queue_enabled")}/></div><div className="flex items-center justify-between gap-3"><Label htmlFor="sales-handoff-task">Criar tarefa nos encaminhamentos qualificados</Label><Switch id="sales-handoff-task" checked={currentOrg?.settings.sales_qualified_handoff_task_enabled===true} disabled={savingWorkspace} onCheckedChange={v=>toggleWorkspace(v,"sales_qualified_handoff_task_enabled")}/></div><div className="flex items-center justify-between gap-3"><Label htmlFor="sales-freeze">Congelar negócios e criar retorno</Label><Switch id="sales-freeze" checked={currentOrg?.settings.sales_opportunity_freeze_enabled===true} disabled={savingWorkspace} onCheckedChange={v=>toggleWorkspace(v,"sales_opportunity_freeze_enabled")}/></div><div className="flex items-center justify-between gap-3"><Label htmlFor="sales-auto">Entrada e avanço automático no funil</Label><Switch id="sales-auto" checked={currentOrg?.settings.sales_auto_pipeline_enabled===true} disabled={savingWorkspace} onCheckedChange={v=>toggleWorkspace(v,"sales_auto_pipeline_enabled")}/></div><div className="flex items-center justify-between gap-3"><Label htmlFor="sales-workspace">Ativar nova visão do funil</Label><Switch id="sales-workspace" checked={currentOrg?.settings.sales_workspace_enabled === true} disabled={savingWorkspace} onCheckedChange={value => toggleWorkspace(value)}/></div><div className="flex items-center justify-between gap-3"><Label htmlFor="low-intent-cadence">Retornos sem tarefa: 1h, 23h e despedida no prazo configurado</Label><Switch id="low-intent-cadence" checked={currentOrg?.settings.sales_low_intent_cadence_enabled === true} disabled={savingWorkspace} onCheckedChange={value => toggleWorkspace(value, "sales_low_intent_cadence_enabled")}/></div><div className="flex items-center justify-between gap-3"><Label htmlFor="silence-retire">Encerrar sozinho tarefas de silêncio sem necessidade de atendimento (7+ dias)</Label><Switch id="silence-retire" checked={currentOrg?.settings.silence_task_auto_retire_enabled === true} disabled={savingWorkspace} onCheckedChange={value => toggleWorkspace(value, "silence_task_auto_retire_enabled")}/></div>{workspaceError && <p role="alert" className="text-sm text-destructive">{workspaceError}</p>}<p className="text-xs text-muted-foreground">As duas opções começam desligadas. A cadência envia mensagens apenas para novos atendimentos elegíveis após a ativação; não marca negócios como perdidos.</p></CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Fase 2 — Triagem de tarefas</CardTitle>
          <CardDescription>
            Automações da triagem de tarefas — todas desligadas até você ativar. A visão "Hoje" no
            Início já funciona independente destas chaves.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="task-auto-link">Vincular tarefas novas à oportunidade automaticamente</Label>
              <p className="text-sm text-muted-foreground">
                Só quando o contato tem exatamente 1 oportunidade aberta.
              </p>
            </div>
            <Switch id="task-auto-link" checked={taskAutoLinkEnabled} onCheckedChange={setTaskAutoLinkEnabled} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="task-consolidation">Consolidar em 1 tarefa por oportunidade</Label>
              <p className="text-sm text-muted-foreground">
                Novas pendências da mesma oportunidade entram na tarefa já aberta em vez de criar outra.
              </p>
            </div>
            <Switch
              id="task-consolidation"
              checked={taskConsolidationEnabled}
              onCheckedChange={setTaskConsolidationEnabled}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="task-auto-close">Encerrar automaticamente "aguardando cliente"</Label>
              <p className="text-sm text-muted-foreground">
                Só CPF e dados do cliente — fecha quando o campo é preenchido depois de uma nova mensagem dele.
              </p>
            </div>
            <Switch id="task-auto-close" checked={taskAutoCloseEnabled} onCheckedChange={setTaskAutoCloseEnabled} />
          </div>

          <div className="flex items-center justify-between border-t pt-4">
            <div>
              <Label htmlFor="libera-cred-resumption">Retomada de LiberaCred parado (plano apresentado)</Label>
              <p className="text-sm text-muted-foreground">
                Cria e escalona tarefas de retomada para oportunidades paradas em "plano e prazo
                apresentados".
              </p>
            </div>
            <Switch id="libera-cred-resumption" checked={liberaCredEnabled} onCheckedChange={setLiberaCredEnabled} />
          </div>

          {liberaCredEnabled && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Janela de interação (dias)</Label>
                <Input
                  type="number"
                  min={1}
                  value={liberaCredWindowDays}
                  onChange={(e) => setLiberaCredWindowDays(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Idade máx. da tabela (dias)</Label>
                <Input
                  type="number"
                  min={1}
                  value={liberaCredTableMaxAgeDays}
                  onChange={(e) => setLiberaCredTableMaxAgeDays(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Limite diário de tarefas novas</Label>
                <Input
                  type="number"
                  min={1}
                  value={liberaCredDailyLimit}
                  onChange={(e) => setLiberaCredDailyLimit(e.target.value)}
                />
              </div>
            </div>
          )}

          <Button onClick={handleSaveFase2Settings} disabled={savingFase2}>
            <Save className="mr-2 h-4 w-4" />
            {savingFase2 ? "Salvando..." : "Salvar"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Follow-up e despedida</CardTitle>
          <CardDescription>
            Deixa a atendente enviar o follow-up de uma tarefa (mensagem sugerida por IA, editável)
            sem abrir o WhatsApp. Desligado até você ativar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="followup-enabled">Habilitar follow-up direto da tarefa</Label>
              <p className="text-sm text-muted-foreground">
                Mostra o bloco de envio nas tarefas elegíveis (aba Tarefas e visão "Hoje").
              </p>
            </div>
            <Switch id="followup-enabled" checked={followupEnabled} onCheckedChange={setFollowupEnabled} />
          </div>

          {followupEnabled && (
            <>
              <div className="flex items-center justify-between border-t pt-4">
                <div>
                  <Label htmlFor="followup-takeover">Ativar takeover ao enviar</Label>
                  <p className="text-sm text-muted-foreground">
                    Por padrão o envio não ativa takeover — a Helena continua respondendo
                    normalmente. Ligue se quiser exigir um humano depois de qualquer follow-up.
                  </p>
                </div>
                <Switch
                  id="followup-takeover"
                  checked={followupTakeoverOnSend}
                  onCheckedChange={setFollowupTakeoverOnSend}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Intervalo mínimo entre envios (segundos)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={followupMinInterval}
                    onChange={(e) => setFollowupMinInterval(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Contado por número de WhatsApp.</p>
                </div>
                <div className="space-y-2">
                  <Label>Limite diário de follow-ups</Label>
                  <Input
                    type="number"
                    min={1}
                    value={followupDailyLimit}
                    onChange={(e) => setFollowupDailyLimit(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Contado por número de WhatsApp.</p>
                </div>
                <div className="space-y-2">
                  <Label>Limite de regenerações por tarefa</Label>
                  <Input
                    type="number"
                    min={1}
                    value={followupMaxRegenerations}
                    onChange={(e) => setFollowupMaxRegenerations(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Vezes que "Gerar outra" pode ser usado.</p>
                </div>
              </div>
            </>
          )}

          <div className="space-y-4 border-t pt-4">
            <div><h3 className="font-medium">Despedida para leads sem resposta</h3><p className="text-sm text-muted-foreground">Depois dos retornos de 1h e 23h, encerra as mensagens sem criar tarefa para o vendedor. Só envia com a cadência ativada.</p></div>
            <div className="space-y-2"><Label htmlFor="closing-hours">Espera após o segundo retorno (horas)</Label><Input id="closing-hours" type="number" min={0.25} max={168} step={0.25} value={closingHours} onChange={e=>setClosingHours(e.target.value)}/><p className="text-xs text-muted-foreground">Padrão: 1 hora após o envio efetivo. Respeita o horário de atendimento e cancela se o cliente responder.</p></div>
            <div className="space-y-2"><Label htmlFor="closing-message">Mensagem de despedida</Label><Textarea id="closing-message" rows={5} maxLength={1000} value={closingMessage} onChange={e=>setClosingMessage(e.target.value)}/></div>
            {closingError && <p role="alert" className="text-sm text-destructive">{closingError}</p>}
            <Button onClick={saveClosingSettings} disabled={savingClosing}><Save className="mr-2 h-4 w-4"/>{savingClosing?"Salvando...":"Salvar despedida"}</Button>
            {currentOrg?.settings.scheduled_ad_closure_batch && <div className="space-y-2 rounded border p-3"><div className="flex items-center justify-between gap-3"><Label htmlFor="scheduled-closure">Fila de despedidas agendada</Label><Switch id="scheduled-closure" checked={currentOrg.settings.scheduled_ad_closure_enabled===true} disabled={savingWorkspace} onCheckedChange={v=>toggleWorkspace(v,"scheduled_ad_closure_enabled")}/></div><p className="text-sm text-muted-foreground">{currentOrg.settings.scheduled_ad_closure_batch.recipients.length} contatos · intervalo mínimo de {currentOrg.settings.scheduled_ad_closure_batch.intervalMinutes} minutos. Desligue para pausar.</p><p className="text-xs text-muted-foreground">A fila usa o texto aprovado no agendamento. Editar a despedida acima vale para os novos atendimentos.</p></div>}
          </div>

          <Button onClick={handleSaveFollowupSettings} disabled={savingFollowup}>
            <Save className="mr-2 h-4 w-4" />
            {savingFollowup ? "Salvando..." : "Salvar"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contatos ignorados</CardTitle>
          <CardDescription>
            Números que o sistema ignora completamente no webhook — nunca criam conversa,
            nunca acionam a IA e nunca geram tarefa. Use para números que não são clientes de
            verdade (ex.: o bot de atendimento de um banco/administradora consultado pela
            própria loja).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ignoredContacts.length > 0 && (
            <div className="space-y-2">
              {ignoredContacts.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-md border p-2">
                  <div>
                    <p className="font-medium">{c.label || c.phone}</p>
                    <p className="text-sm text-muted-foreground">
                      {c.phone} · {c.retention_mode === "no_store" ? "não grava nada" : "grava registro mínimo"}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => handleDeleteIgnoredContact(c.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Telefone</Label>
              <Input
                value={newIgnoredPhone}
                onChange={(e) => setNewIgnoredPhone(e.target.value)}
                placeholder="Só números, com DDI (ex.: 5511999998888)"
              />
            </div>
            <div className="space-y-2">
              <Label>Nome/etiqueta (opcional)</Label>
              <Input value={newIgnoredLabel} onChange={(e) => setNewIgnoredLabel(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>O que fazer com as mensagens desse número</Label>
            <Select value={newIgnoredMode} onValueChange={(v) => setNewIgnoredMode(v as IgnoredContactRetentionMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no_store">Não gravar nada (recomendado)</SelectItem>
                <SelectItem value="minimal_record">Gravar um registro mínimo, sem o conteúdo real</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button onClick={handleAddIgnoredContact} disabled={savingIgnored || !newIgnoredPhone.trim()}>
            {savingIgnored ? "Adicionando..." : "Adicionar"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
