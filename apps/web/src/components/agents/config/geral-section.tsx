"use client";

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ImportSystemPromptDialog } from "./import-system-prompt-dialog";
import type { AgentConfigDraft, AgentModelSettings } from "@aula-agente/shared";

const PROVIDER_LABELS: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google" };
const MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  anthropic: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
  google: ["gemini-2.0-flash", "gemini-2.0-flash-lite"],
};

interface GeralSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { identity?: AgentConfigDraft["identity"]; model_settings?: AgentModelSettings }) => Promise<void>;
  agentId: string;
  onImported: () => Promise<void>;
}

export function GeralSection({ draft, onPatch, agentId, onImported }: GeralSectionProps) {
  const [identity, setIdentity] = useState(draft.identity);
  const [modelSettings, setModelSettings] = useState(draft.model_settings);
  const [identityDirty, setIdentityDirty] = useState(false);
  const [modelSettingsDirty, setModelSettingsDirty] = useState(false);

  useEffect(() => {
    if (!identityDirty) setIdentity(draft.identity);
    if (!modelSettingsDirty) setModelSettings(draft.model_settings);
  }, [draft.updated_at]);

  const saveIdentity = async (next: typeof identity) => {
    await onPatch({ identity: next });
    setIdentityDirty(false);
  };

  const saveModelSettings = async (next: AgentModelSettings) => {
    await onPatch({ model_settings: next });
    setModelSettingsDirty(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ImportSystemPromptDialog agentId={agentId} onApplied={onImported} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Identidade</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input value={identity.nome} onChange={(e) => { setIdentity({ ...identity, nome: e.target.value }); setIdentityDirty(true); }} onBlur={() => saveIdentity(identity)} />
          </div>
          <div className="space-y-2">
            <Label>Função</Label>
            <Input value={identity.funcao} onChange={(e) => { setIdentity({ ...identity, funcao: e.target.value }); setIdentityDirty(true); }} onBlur={() => saveIdentity(identity)} />
          </div>
          <div className="space-y-2">
            <Label>Missão / instruções principais</Label>
            <Textarea rows={8} value={identity.missao} onChange={(e) => { setIdentity({ ...identity, missao: e.target.value }); setIdentityDirty(true); }} onBlur={() => saveIdentity(identity)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Modelo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Provider</Label>
              <Select
                value={modelSettings.provider}
                onValueChange={(v) => {
                  if (!v) return;
                  const next = { ...modelSettings, provider: v as AgentModelSettings["provider"], model: MODELS[v][0] };
                  setModelSettings(next);
                  setModelSettingsDirty(true);
                  saveModelSettings(next);
                }}
              >
                <SelectTrigger>
                  <SelectValue>{(value: string) => PROVIDER_LABELS[value] ?? value}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Modelo</Label>
              <Select
                value={modelSettings.model}
                onValueChange={(v) => {
                  if (!v) return;
                  const next = { ...modelSettings, model: v };
                  setModelSettings(next);
                  setModelSettingsDirty(true);
                  saveModelSettings(next);
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(MODELS[modelSettings.provider] || []).map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Temperatura ({modelSettings.temperature})</Label>
              <Input
                type="range" min="0" max="2" step="0.1"
                value={modelSettings.temperature}
                onChange={(e) => { setModelSettings({ ...modelSettings, temperature: Number(e.target.value) }); setModelSettingsDirty(true); }}
                onMouseUp={() => saveModelSettings(modelSettings)}
              />
            </div>
            <div className="space-y-2">
              <Label>Max Tokens</Label>
              <Input
                type="number"
                value={modelSettings.max_tokens}
                onChange={(e) => { setModelSettings({ ...modelSettings, max_tokens: Number(e.target.value) }); setModelSettingsDirty(true); }}
                onBlur={() => saveModelSettings(modelSettings)}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
