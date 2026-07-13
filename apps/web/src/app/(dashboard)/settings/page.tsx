"use client";

import { useEffect, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Eye, EyeOff, Save } from "lucide-react";
import type { LLMProvider } from "@aula-agente/shared";

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

  useEffect(() => {
    if (!currentOrg) return;
    setName(currentOrg.name);
    fetchApiKeys();
  }, [currentOrg]);

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
    </div>
  );
}
