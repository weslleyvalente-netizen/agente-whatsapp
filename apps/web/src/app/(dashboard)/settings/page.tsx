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
import type { LLMProvider, IgnoredContactRetentionMode, OrganizationIgnoredContact } from "@aula-agente/shared";
import {
  DEFAULT_HUMAN_TAKEOVER_TIMEOUT_MINUTES,
  DEFAULT_HANDOFF_UNANSWERED_ALERT_MINUTES,
  DEFAULT_GREETING_FILTER_ENABLED,
  DEFAULT_GREETING_WORDS,
  DEFAULT_GREETING_MAX_LENGTH,
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
