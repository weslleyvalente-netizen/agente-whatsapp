# Fase 6: Dashboard — Evolution API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar gestao de instancias Evolution API no dashboard: listar, criar, conectar via QR code, ver status, vincular agente, desconectar/excluir.

**Architecture:** Paginas interagem com o backend API (nao direto Supabase) para operacoes Evolution. Status e QR code buscados em tempo real da Evolution API via backend.

**Tech Stack:** Next.js 15, shadcn/ui, API client

**Depends on:** Fase 2 (instance routes), Fase 4 (dashboard layout)

---

### Task 1: Pagina de Lista de Instancias

**Files:**
- Create: `apps/web/src/app/(dashboard)/instances/page.tsx`
- Create: `apps/web/src/components/instances/instance-card.tsx`

- [ ] **Step 1: Criar instance-card.tsx**

Criar `apps/web/src/components/instances/instance-card.tsx`:
```tsx
"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Radio, Phone } from "lucide-react";

interface InstanceCardProps {
  instance: {
    id: string;
    instance_name: string;
    status: string;
    phone_number: string | null;
    agents?: { id: string; name: string } | null;
  };
}

export function InstanceCard({ instance }: InstanceCardProps) {
  const statusVariant: Record<string, "default" | "secondary" | "destructive"> = {
    connected: "default",
    disconnected: "destructive",
    connecting: "secondary",
  };

  return (
    <Link href={`/instances/${instance.id}`}>
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader className="flex flex-row items-center gap-3 pb-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
            <Radio className="h-5 w-5 text-green-500" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base">{instance.instance_name}</CardTitle>
            {instance.phone_number && (
              <p className="flex items-center gap-1 text-sm text-muted-foreground">
                <Phone className="h-3 w-3" />
                {instance.phone_number}
              </p>
            )}
          </div>
          <Badge variant={statusVariant[instance.status] || "secondary"}>
            {instance.status}
          </Badge>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Agente: {instance.agents?.name || "Nenhum vinculado"}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
```

- [ ] **Step 2: Criar pagina de lista**

Criar `apps/web/src/app/(dashboard)/instances/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { apiFetch } from "@/lib/api";
import { InstanceCard } from "@/components/instances/instance-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Radio } from "lucide-react";

export default function InstancesPage() {
  const { currentOrg } = useOrganization();
  const [instances, setInstances] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchInstances = async () => {
    if (!currentOrg) return;
    const data = await apiFetch(`/organizations/${currentOrg.id}/instances`);
    setInstances(data || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchInstances();
  }, [currentOrg]);

  const handleCreate = async () => {
    if (!newName) return;
    setCreating(true);
    try {
      await apiFetch(`/organizations/${currentOrg!.id}/instances`, {
        method: "POST",
        body: JSON.stringify({ instance_name: newName }),
      });
      setNewName("");
      setDialogOpen(false);
      await fetchInstances();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao criar instancia");
    } finally {
      setCreating(false);
    }
  };

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Instancias WhatsApp</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Nova Instancia
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Criar Instancia</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                placeholder="Nome da instancia"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <Button onClick={handleCreate} disabled={creating || !newName} className="w-full">
                {creating ? "Criando..." : "Criar"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {instances.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <Radio className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-semibold">Nenhuma instancia</h3>
          <p className="text-muted-foreground">Conecte seu WhatsApp criando uma instancia</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {instances.map((instance) => (
            <InstanceCard key={instance.id} instance={instance} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/instances/page.tsx apps/web/src/components/instances/
git commit -m "feat(web): add instances list page with create dialog"
```

---

### Task 2: Pagina de Detalhes da Instancia (QR Code + Status + Vincular Agente)

**Files:**
- Create: `apps/web/src/app/(dashboard)/instances/[instanceId]/page.tsx`
- Create: `apps/web/src/components/instances/qrcode-dialog.tsx`
- Create: `apps/web/src/components/instances/instance-status.tsx`

- [ ] **Step 1: Criar qrcode-dialog.tsx**

Criar `apps/web/src/components/instances/qrcode-dialog.tsx`:
```tsx
"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { QrCode, Loader2 } from "lucide-react";

interface QrCodeDialogProps {
  instanceId: string;
}

export function QrCodeDialog({ instanceId }: QrCodeDialogProps) {
  const [open, setOpen] = useState(false);
  const [qrData, setQrData] = useState<{ base64?: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;

    const fetchQr = async () => {
      setLoading(true);
      try {
        const data = await apiFetch(`/instances/${instanceId}/qrcode`);
        setQrData(data);
      } catch {
        setQrData(null);
      }
      setLoading(false);
    };

    fetchQr();

    // Refresh QR every 20 seconds
    const interval = setInterval(fetchQr, 20_000);
    return () => clearInterval(interval);
  }, [open, instanceId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <QrCode className="mr-2 h-4 w-4" />
          Conectar via QR Code
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Escanear QR Code</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-[300px] items-center justify-center">
          {loading ? (
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          ) : qrData?.base64 ? (
            <img
              src={`data:image/png;base64,${qrData.base64}`}
              alt="QR Code"
              className="h-64 w-64"
            />
          ) : qrData?.code ? (
            <img
              src={`data:image/png;base64,${qrData.code}`}
              alt="QR Code"
              className="h-64 w-64"
            />
          ) : (
            <p className="text-muted-foreground">
              Instancia ja conectada ou QR code indisponivel
            </p>
          )}
        </div>
        <p className="text-center text-xs text-muted-foreground">
          O QR Code atualiza automaticamente a cada 20 segundos
        </p>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Criar instance-status.tsx**

Criar `apps/web/src/components/instances/instance-status.tsx`:
```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

interface InstanceStatusProps {
  instanceId: string;
  initialStatus: string;
  onStatusChange: (status: string) => void;
}

export function InstanceStatus({ instanceId, initialStatus, onStatusChange }: InstanceStatusProps) {
  const [status, setStatus] = useState(initialStatus);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await apiFetch(`/instances/${instanceId}/status`);
      setStatus(data.status);
      onStatusChange(data.status);
    } catch {
      // ignore
    }
    setRefreshing(false);
  };

  const statusVariant: Record<string, "default" | "secondary" | "destructive"> = {
    connected: "default",
    disconnected: "destructive",
    connecting: "secondary",
  };

  return (
    <div className="flex items-center gap-2">
      <Badge variant={statusVariant[status] || "secondary"}>{status}</Badge>
      <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={refreshing}>
        <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Criar pagina de detalhes**

Criar `apps/web/src/app/(dashboard)/instances/[instanceId]/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { QrCodeDialog } from "@/components/instances/qrcode-dialog";
import { InstanceStatus } from "@/components/instances/instance-status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Trash2, LogOut } from "lucide-react";
import Link from "next/link";
import type { Agent, EvolutionInstance } from "@aula-agente/shared";

export default function InstanceDetailPage() {
  const { instanceId } = useParams<{ instanceId: string }>();
  const router = useRouter();
  const [instance, setInstance] = useState<EvolutionInstance | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      const supabase = createClient();

      const { data: inst } = await supabase
        .from("evolution_instances")
        .select("*")
        .eq("id", instanceId)
        .single();
      setInstance(inst as EvolutionInstance);

      if (inst) {
        const { data: agentList } = await supabase
          .from("agents")
          .select("*")
          .eq("organization_id", inst.organization_id)
          .eq("is_active", true);
        setAgents((agentList as Agent[]) || []);
      }

      setLoading(false);
    };
    fetchData();
  }, [instanceId]);

  const handleAssignAgent = async (agentId: string) => {
    await apiFetch(`/instances/${instanceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        active_agent_id: agentId === "none" ? null : agentId,
      }),
    });
    setInstance((prev) => prev ? { ...prev, active_agent_id: agentId === "none" ? null : agentId } : null);
  };

  const handleLogout = async () => {
    if (!confirm("Desconectar instancia?")) return;
    await apiFetch(`/instances/${instanceId}/logout`, { method: "POST" });
    setInstance((prev) => prev ? { ...prev, status: "disconnected" } : null);
  };

  const handleDelete = async () => {
    if (!confirm("Excluir instancia permanentemente?")) return;
    await apiFetch(`/instances/${instanceId}`, { method: "DELETE" });
    router.push("/instances");
  };

  if (loading) return <div>Carregando...</div>;
  if (!instance) return <div>Instancia nao encontrada</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/instances">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <h1 className="text-2xl font-bold">{instance.instance_name}</h1>
        <InstanceStatus
          instanceId={instanceId}
          initialStatus={instance.status}
          onStatusChange={(s) => setInstance((prev) => prev ? { ...prev, status: s } : null)}
        />
      </div>

      <Card>
        <CardHeader><CardTitle>Conexao</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Telefone</p>
              <p className="text-sm text-muted-foreground">{instance.phone_number || "Nao conectado"}</p>
            </div>
            <div className="flex gap-2">
              <QrCodeDialog instanceId={instanceId} />
              {instance.status === "connected" && (
                <Button variant="outline" onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  Desconectar
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Agente Vinculado</CardTitle></CardHeader>
        <CardContent>
          <Select
            value={instance.active_agent_id || "none"}
            onValueChange={handleAssignAgent}
          >
            <SelectTrigger><SelectValue placeholder="Selecionar agente" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nenhum agente</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-2 text-xs text-muted-foreground">
            O agente vinculado atendera as mensagens recebidas nesta instancia
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button variant="destructive" onClick={handleDelete}>
          <Trash2 className="mr-2 h-4 w-4" />
          Excluir Instancia
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/instances/ apps/web/src/components/instances/
git commit -m "feat(web): add instance detail page with QR code, status, and agent assignment"
```

---

### Task 3: Verificacao Final da Fase 6

- [ ] **Step 1: Verificar build**

```bash
cd apps/web && pnpm build
```

- [ ] **Step 2: Commit final**

```bash
git add -A && git status
git commit -m "chore: phase 6 final adjustments"
```
