"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { createAgentSchema } from "@aula-agente/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const agentFormSchema = createAgentSchema.extend({ is_active: z.boolean().default(true) });
type AgentFormInput = z.input<typeof agentFormSchema>;
type AgentFormOutput = z.output<typeof agentFormSchema>;

interface AgentFormProps {
  defaultValues?: Partial<AgentFormInput>;
  onSubmit: (values: AgentFormOutput) => Promise<void>;
  submitLabel: string;
}

const PROVIDER_LABELS: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google" };

const MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  anthropic: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
  google: ["gemini-2.0-flash", "gemini-2.0-flash-lite"],
};

export function AgentForm({ defaultValues, onSubmit, submitLabel }: AgentFormProps) {
  const form = useForm<AgentFormInput, any, AgentFormOutput>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: "",
      description: "",
      system_prompt: "",
      model: "gpt-4o-mini",
      provider: "openai",
      temperature: 0.7,
      max_tokens: 1024,
      tools_config: { search_knowledge: true, search_faq: true, send_catalog_photo: false },
      is_active: true,
      ...defaultValues,
    },
  });

  const provider = form.watch("provider");

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Informacoes Basicas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nome</Label>
            <Input id="name" {...form.register("name")} placeholder="Assistente de Suporte" />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Descricao</Label>
            <Input id="description" {...form.register("description")} placeholder="Agente para atendimento ao cliente" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="system_prompt">System Prompt</Label>
            <Textarea
              id="system_prompt"
              {...form.register("system_prompt")}
              placeholder="Voce e um assistente de suporte..."
              rows={8}
            />
            {form.formState.errors.system_prompt && (
              <p className="text-sm text-destructive">{form.formState.errors.system_prompt.message}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              checked={form.watch("is_active")}
              onCheckedChange={(v) => form.setValue("is_active", v)}
            />
            <Label>Agente ativo</Label>
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
                value={provider}
                onValueChange={(v) => {
                  if (!v) return;
                  form.setValue("provider", v as any);
                  form.setValue("model", MODELS[v][0]);
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
              <Select value={form.watch("model")} onValueChange={(v) => v && form.setValue("model", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(MODELS[provider] || []).map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Temperatura ({form.watch("temperature")})</Label>
              <Input
                type="range"
                min="0"
                max="2"
                step="0.1"
                {...form.register("temperature", { valueAsNumber: true })}
              />
            </div>

            <div className="space-y-2">
              <Label>Max Tokens</Label>
              <Input type="number" {...form.register("max_tokens", { valueAsNumber: true })} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tools</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Busca na Base de Conhecimento</p>
              <p className="text-sm text-muted-foreground">Permite ao agente buscar em documentos enviados</p>
            </div>
            <Switch
              checked={form.watch("tools_config.search_knowledge")}
              onCheckedChange={(v) => form.setValue("tools_config.search_knowledge", v)}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Busca de FAQs</p>
              <p className="text-sm text-muted-foreground">Permite ao agente consultar perguntas frequentes</p>
            </div>
            <Switch
              checked={form.watch("tools_config.search_faq")}
              onCheckedChange={(v) => form.setValue("tools_config.search_faq", v)}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Catálogo de Veículos</p>
              <p className="text-sm text-muted-foreground">Permite ao agente buscar veículos e enviar fotos pelo WhatsApp</p>
            </div>
            <Switch
              checked={form.watch("tools_config.send_catalog_photo")}
              onCheckedChange={(v) => form.setValue("tools_config.send_catalog_photo", v)}
            />
          </div>
        </CardContent>
      </Card>

      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? "Salvando..." : submitLabel}
      </Button>
    </form>
  );
}
