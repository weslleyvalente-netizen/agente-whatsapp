# Fase 5: Dashboard — Gestao de Agentes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar CRUD completo de agentes no dashboard: listar, criar, editar (nome, prompt, modelo, provider, temperatura), gerenciar tools, upload de documentos para knowledge base, e CRUD de FAQs.

**Architecture:** Paginas Next.js App Router com data fetching via Supabase SDK direto (RLS). Upload de documentos via API backend (precisa enfileirar job). FAQs via Supabase direto.

**Tech Stack:** Next.js 15, Supabase SDK, shadcn/ui, React Hook Form, Zod

**Depends on:** Fase 4 (dashboard layout, auth, org provider)

---

### Task 1: Pagina de Lista de Agentes

**Files:**
- Create: `apps/web/src/app/(dashboard)/agents/page.tsx`
- Create: `apps/web/src/components/agents/agent-card.tsx`

- [ ] **Step 1: Criar agent-card.tsx**

Criar `apps/web/src/components/agents/agent-card.tsx`:
```tsx
"use client";

import Link from "next/link";
import type { Agent } from "@aula-agente/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot } from "lucide-react";

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
  return (
    <Link href={`/agents/${agent.id}`}>
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader className="flex flex-row items-center gap-3 pb-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Bot className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base">{agent.name}</CardTitle>
            <p className="text-sm text-muted-foreground">{agent.description || "Sem descricao"}</p>
          </div>
          <Badge variant={agent.is_active ? "default" : "secondary"}>
            {agent.is_active ? "Ativo" : "Inativo"}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>Modelo: {agent.model}</span>
            <span>Provider: {agent.provider}</span>
            <span>Temp: {agent.temperature}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
```

- [ ] **Step 2: Criar pagina de lista**

Criar `apps/web/src/app/(dashboard)/agents/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { AgentCard } from "@/components/agents/agent-card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import type { Agent } from "@aula-agente/shared";

export default function AgentsPage() {
  const { currentOrg } = useOrganization();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg) return;

    const fetchAgents = async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("agents")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });

      setAgents((data as Agent[]) || []);
      setLoading(false);
    };

    fetchAgents();
  }, [currentOrg]);

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agentes</h1>
        <Link href="/agents/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Novo Agente
          </Button>
        </Link>
      </div>

      {agents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <Bot className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-semibold">Nenhum agente</h3>
          <p className="text-muted-foreground">Crie seu primeiro agente para comecar</p>
          <Link href="/agents/new">
            <Button className="mt-4">
              <Plus className="mr-2 h-4 w-4" />
              Criar Agente
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/agents/page.tsx apps/web/src/components/agents/
git commit -m "feat(web): add agents list page with agent cards"
```

---

### Task 2: Formulario de Criar/Editar Agente

**Files:**
- Create: `apps/web/src/components/agents/agent-form.tsx`
- Create: `apps/web/src/app/(dashboard)/agents/new/page.tsx`
- Create: `apps/web/src/app/(dashboard)/agents/[agentId]/page.tsx`

- [ ] **Step 1: Instalar react-hook-form**

```bash
cd apps/web && pnpm add react-hook-form @hookform/resolvers
```

- [ ] **Step 2: Criar agent-form.tsx**

Criar `apps/web/src/components/agents/agent-form.tsx`:
```tsx
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

type AgentFormValues = z.infer<typeof createAgentSchema>;

interface AgentFormProps {
  defaultValues?: Partial<AgentFormValues & { is_active: boolean }>;
  onSubmit: (values: AgentFormValues & { is_active?: boolean }) => Promise<void>;
  submitLabel: string;
}

const MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  anthropic: ["claude-sonnet-4-20250514", "claude-haiku-4-20250414"],
  google: ["gemini-2.0-flash", "gemini-2.0-flash-lite"],
};

export function AgentForm({ defaultValues, onSubmit, submitLabel }: AgentFormProps) {
  const form = useForm<AgentFormValues & { is_active: boolean }>({
    resolver: zodResolver(
      createAgentSchema.extend({ is_active: z.boolean().default(true) })
    ),
    defaultValues: {
      name: "",
      description: "",
      system_prompt: "",
      model: "gpt-4o-mini",
      provider: "openai",
      temperature: 0.7,
      max_tokens: 1024,
      tools_config: { search_knowledge: true, search_faq: true },
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
                  form.setValue("provider", v as any);
                  form.setValue("model", MODELS[v][0]);
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Modelo</Label>
              <Select value={form.watch("model")} onValueChange={(v) => form.setValue("model", v)}>
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
        </CardContent>
      </Card>

      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? "Salvando..." : submitLabel}
      </Button>
    </form>
  );
}
```

- [ ] **Step 3: Criar pagina de novo agente**

Criar `apps/web/src/app/(dashboard)/agents/new/page.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { AgentForm } from "@/components/agents/agent-form";

export default function NewAgentPage() {
  const router = useRouter();
  const { currentOrg } = useOrganization();

  const handleSubmit = async (values: Record<string, unknown>) => {
    if (!currentOrg) return;
    const supabase = createClient();

    const { error } = await supabase.from("agents").insert({
      ...values,
      organization_id: currentOrg.id,
    });

    if (error) throw error;
    router.push("/agents");
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Novo Agente</h1>
      <AgentForm onSubmit={handleSubmit} submitLabel="Criar Agente" />
    </div>
  );
}
```

- [ ] **Step 4: Criar pagina de editar agente**

Criar `apps/web/src/app/(dashboard)/agents/[agentId]/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { AgentForm } from "@/components/agents/agent-form";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Trash2 } from "lucide-react";
import type { Agent } from "@aula-agente/shared";
import Link from "next/link";

export default function EditAgentPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const router = useRouter();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAgent = async () => {
      const supabase = createClient();
      const { data } = await supabase.from("agents").select("*").eq("id", agentId).single();
      setAgent(data as Agent);
      setLoading(false);
    };
    fetchAgent();
  }, [agentId]);

  const handleSubmit = async (values: Record<string, unknown>) => {
    const supabase = createClient();
    const { error } = await supabase.from("agents").update(values).eq("id", agentId);
    if (error) throw error;
    router.push("/agents");
  };

  const handleDelete = async () => {
    if (!confirm("Tem certeza que deseja excluir este agente?")) return;
    const supabase = createClient();
    await supabase.from("agents").delete().eq("id", agentId);
    router.push("/agents");
  };

  if (loading) return <div>Carregando...</div>;
  if (!agent) return <div>Agente nao encontrado</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{agent.name}</h1>
        <div className="flex gap-2">
          <Link href={`/agents/${agentId}/knowledge`}>
            <Button variant="outline">Base de Conhecimento</Button>
          </Link>
          <Button variant="destructive" size="icon" onClick={handleDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <AgentForm
        defaultValues={agent}
        onSubmit={handleSubmit}
        submitLabel="Salvar Alteracoes"
      />
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agents/agent-form.tsx apps/web/src/app/\(dashboard\)/agents/
git commit -m "feat(web): add agent create and edit pages with full form"
```

---

### Task 3: Pagina de Knowledge Base (Documentos + FAQs)

**Files:**
- Create: `apps/web/src/app/(dashboard)/agents/[agentId]/knowledge/page.tsx`
- Create: `apps/web/src/components/agents/document-upload.tsx`
- Create: `apps/web/src/components/agents/faq-manager.tsx`

- [ ] **Step 1: Criar document-upload.tsx**

Criar `apps/web/src/components/agents/document-upload.tsx`:
```tsx
"use client";

import { useState, useRef } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Upload, Trash2, FileText, Loader2 } from "lucide-react";
import type { KnowledgeDocument } from "@aula-agente/shared";

interface DocumentUploadProps {
  agentId: string;
  documents: KnowledgeDocument[];
  onRefresh: () => void;
}

export function DocumentUpload({ agentId, documents, onRefresh }: DocumentUploadProps) {
  const { currentOrg } = useOrganization();
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentOrg) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", file.name);

      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
      const response = await fetch(
        `${API_URL}/organizations/${currentOrg.id}/agents/${agentId}/documents`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Upload failed");
      }

      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro no upload");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async (docId: string) => {
    if (!confirm("Excluir documento?")) return;
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    await fetch(`${API_URL}/documents/${docId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });
    onRefresh();
  };

  const statusColors: Record<string, "default" | "secondary" | "destructive"> = {
    ready: "default",
    processing: "secondary",
    error: "destructive",
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Documentos</CardTitle>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.txt,.md,.docx,.csv"
            onChange={handleUpload}
            className="hidden"
          />
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            size="sm"
          >
            {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            Upload
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum documento enviado</p>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between rounded-md border p-3">
                <div className="flex items-center gap-3">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{doc.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {doc.file_type.toUpperCase()} - {doc.chunk_count} chunks
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={statusColors[doc.status]}>{doc.status}</Badge>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(doc.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Criar faq-manager.tsx**

Criar `apps/web/src/components/agents/faq-manager.tsx`:
```tsx
"use client";

import { useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2 } from "lucide-react";
import type { KnowledgeFaq } from "@aula-agente/shared";

interface FaqManagerProps {
  agentId: string;
  faqs: KnowledgeFaq[];
  onRefresh: () => void;
}

export function FaqManager({ agentId, faqs, onRefresh }: FaqManagerProps) {
  const { currentOrg } = useOrganization();
  const [showForm, setShowForm] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!currentOrg || !question || !answer) return;
    setSaving(true);

    const supabase = createClient();
    await supabase.from("knowledge_faqs").insert({
      agent_id: agentId,
      organization_id: currentOrg.id,
      question,
      answer,
      is_active: true,
    });

    setQuestion("");
    setAnswer("");
    setShowForm(false);
    setSaving(false);
    onRefresh();
  };

  const handleToggle = async (faqId: string, isActive: boolean) => {
    const supabase = createClient();
    await supabase.from("knowledge_faqs").update({ is_active: isActive }).eq("id", faqId);
    onRefresh();
  };

  const handleDelete = async (faqId: string) => {
    if (!confirm("Excluir FAQ?")) return;
    const supabase = createClient();
    await supabase.from("knowledge_faqs").delete().eq("id", faqId);
    onRefresh();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>FAQs</CardTitle>
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="mr-2 h-4 w-4" />
          Adicionar FAQ
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {showForm && (
          <div className="space-y-3 rounded-md border p-4">
            <Input
              placeholder="Pergunta"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <Textarea
              placeholder="Resposta"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={3}
            />
            <div className="flex gap-2">
              <Button onClick={handleAdd} disabled={saving || !question || !answer} size="sm">
                {saving ? "Salvando..." : "Salvar"}
              </Button>
              <Button variant="ghost" onClick={() => setShowForm(false)} size="sm">
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {faqs.length === 0 && !showForm ? (
          <p className="text-sm text-muted-foreground">Nenhuma FAQ cadastrada</p>
        ) : (
          <div className="space-y-2">
            {faqs.map((faq) => (
              <div key={faq.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="text-sm font-medium">{faq.question}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{faq.answer}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={faq.is_active}
                      onCheckedChange={(v) => handleToggle(faq.id, v)}
                    />
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(faq.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Criar pagina de knowledge base**

Criar `apps/web/src/app/(dashboard)/agents/[agentId]/knowledge/page.tsx`:
```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DocumentUpload } from "@/components/agents/document-upload";
import { FaqManager } from "@/components/agents/faq-manager";
import type { KnowledgeDocument, KnowledgeFaq } from "@aula-agente/shared";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function KnowledgePage() {
  const { agentId } = useParams<{ agentId: string }>();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [faqs, setFaqs] = useState<KnowledgeFaq[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const supabase = createClient();

    const [docsResult, faqsResult] = await Promise.all([
      supabase
        .from("knowledge_documents")
        .select("*")
        .eq("agent_id", agentId)
        .order("created_at", { ascending: false }),
      supabase
        .from("knowledge_faqs")
        .select("*")
        .eq("agent_id", agentId)
        .order("created_at", { ascending: false }),
    ]);

    setDocuments((docsResult.data as KnowledgeDocument[]) || []);
    setFaqs((faqsResult.data as KnowledgeFaq[]) || []);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/agents/${agentId}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">Base de Conhecimento</h1>
      </div>

      <DocumentUpload agentId={agentId} documents={documents} onRefresh={fetchData} />
      <FaqManager agentId={agentId} faqs={faqs} onRefresh={fetchData} />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agents/ apps/web/src/app/\(dashboard\)/agents/
git commit -m "feat(web): add knowledge base page with document upload and FAQ manager"
```

---

### Task 4: Verificacao Final da Fase 5

- [ ] **Step 1: Verificar build**

```bash
cd apps/web && pnpm build
```

Esperado: sem erros.

- [ ] **Step 2: Commit final**

```bash
git add -A && git status
git commit -m "chore: phase 5 final adjustments"
```
