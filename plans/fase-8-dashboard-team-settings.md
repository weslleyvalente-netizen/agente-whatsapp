# Fase 8: Dashboard — Team & Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar paginas de gestao de equipe (membros, convites, roles) e configuracoes da organizacao (nome, plano, API keys dos providers LLM via vault).

**Architecture:** CRUD de membros e convites via Supabase SDK direto com RLS. API keys salvas na tabela organization_secrets (vault). Settings de org via Supabase direto.

**Tech Stack:** Next.js 15, Supabase SDK, shadcn/ui

**Depends on:** Fase 4 (layout, auth, org provider)

---

### Task 1: Pagina de Equipe — Membros

**Files:**
- Create: `apps/web/src/app/(dashboard)/team/page.tsx`
- Create: `apps/web/src/components/team/members-list.tsx`
- Create: `apps/web/src/components/team/invite-dialog.tsx`

- [ ] **Step 1: Criar members-list.tsx**

Criar `apps/web/src/components/team/members-list.tsx`:
```tsx
"use client";

import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2 } from "lucide-react";

interface Member {
  id: string;
  user_id: string;
  role: string;
  created_at: string;
}

interface MembersListProps {
  members: Member[];
  currentUserId: string;
  currentUserRole: string;
  onRefresh: () => void;
}

export function MembersList({ members, currentUserId, currentUserRole, onRefresh }: MembersListProps) {
  const canManage = currentUserRole === "owner" || currentUserRole === "admin";

  const handleRoleChange = async (memberId: string, newRole: string) => {
    const supabase = createClient();
    await supabase
      .from("organization_members")
      .update({ role: newRole })
      .eq("id", memberId);
    onRefresh();
  };

  const handleRemove = async (memberId: string) => {
    if (!confirm("Remover este membro?")) return;
    const supabase = createClient();
    await supabase.from("organization_members").delete().eq("id", memberId);
    onRefresh();
  };

  return (
    <div className="space-y-2">
      {members.map((member) => {
        const isCurrentUser = member.user_id === currentUserId;
        const isOwner = member.role === "owner";

        return (
          <div key={member.id} className="flex items-center justify-between rounded-md border p-3">
            <div className="flex items-center gap-3">
              <Avatar className="h-8 w-8">
                <AvatarFallback>{member.user_id.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium">
                  {member.user_id.slice(0, 8)}...
                  {isCurrentUser && " (voce)"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Desde {new Date(member.created_at).toLocaleDateString("pt-BR")}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {canManage && !isOwner && !isCurrentUser ? (
                <>
                  <Select value={member.role} onValueChange={(v) => handleRoleChange(member.id, v)}>
                    <SelectTrigger className="w-28 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="agent">Agente</SelectItem>
                    </SelectContent>
                  </Select>
                  {currentUserRole === "owner" && (
                    <Button variant="ghost" size="icon" onClick={() => handleRemove(member.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </>
              ) : (
                <Badge variant={isOwner ? "default" : "secondary"}>{member.role}</Badge>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Criar invite-dialog.tsx**

Criar `apps/web/src/components/team/invite-dialog.tsx`:
```tsx
"use client";

import { useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus } from "lucide-react";

interface InviteDialogProps {
  onInvited: () => void;
}

export function InviteDialog({ onInvited }: InviteDialogProps) {
  const { currentOrg } = useOrganization();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("agent");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!email || !currentOrg) return;
    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const { error: insertError } = await supabase
        .from("organization_invitations")
        .insert({
          organization_id: currentOrg.id,
          email,
          role,
          invited_by: user!.id,
          status: "pending",
          expires_at: expiresAt,
        });

      if (insertError) throw insertError;

      setEmail("");
      setRole("agent");
      setOpen(false);
      onInvited();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao convidar");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="mr-2 h-4 w-4" />
          Convidar
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convidar Membro</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@exemplo.com"
            />
          </div>
          <div className="space-y-2">
            <Label>Funcao</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="agent">Agente</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={handleSubmit} disabled={loading || !email} className="w-full">
            {loading ? "Enviando..." : "Enviar Convite"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Criar pagina de equipe**

Criar `apps/web/src/app/(dashboard)/team/page.tsx`:
```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { MembersList } from "@/components/team/members-list";
import { InviteDialog } from "@/components/team/invite-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export default function TeamPage() {
  const { currentOrg } = useOrganization();
  const [members, setMembers] = useState<any[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [currentUserRole, setCurrentUserRole] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!currentOrg) return;
    const supabase = createClient();

    const { data: { user } } = await supabase.auth.getUser();
    setCurrentUserId(user!.id);

    const [membersResult, invitationsResult] = await Promise.all([
      supabase
        .from("organization_members")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at"),
      supabase
        .from("organization_invitations")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
    ]);

    const membersList = membersResult.data || [];
    setMembers(membersList);
    setInvitations(invitationsResult.data || []);

    const myMembership = membersList.find((m: any) => m.user_id === user!.id);
    setCurrentUserRole(myMembership?.role || "agent");

    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Equipe</h1>
        {(currentUserRole === "owner" || currentUserRole === "admin") && (
          <InviteDialog onInvited={fetchData} />
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Membros ({members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <MembersList
            members={members}
            currentUserId={currentUserId}
            currentUserRole={currentUserRole}
            onRefresh={fetchData}
          />
        </CardContent>
      </Card>

      {invitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Convites Pendentes ({invitations.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {invitations.map((inv: any) => (
                <div key={inv.id} className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="text-sm">{inv.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Expira em {new Date(inv.expires_at).toLocaleDateString("pt-BR")}
                    </p>
                  </div>
                  <Badge variant="secondary">{inv.role}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/team/ apps/web/src/components/team/
git commit -m "feat(web): add team page with members, roles, and invitations"
```

---

### Task 2: Pagina de Configuracoes

**Files:**
- Create: `apps/web/src/app/(dashboard)/settings/page.tsx`

- [ ] **Step 1: Criar pagina de settings**

Criar `apps/web/src/app/(dashboard)/settings/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/settings/
git commit -m "feat(web): add settings page with org config and API key management"
```

---

### Task 3: Verificacao Final da Fase 8

- [ ] **Step 1: Verificar build do dashboard completo**

```bash
cd apps/web && pnpm build
```

Esperado: sem erros.

- [ ] **Step 2: Verificar tipagem do monorepo inteiro**

```bash
pnpm typecheck
```

Esperado: sem erros.

- [ ] **Step 3: Verificar Docker Compose valido**

```bash
docker compose config --quiet
```

Esperado: sem erros.

- [ ] **Step 4: Commit final**

```bash
git add -A && git status
git commit -m "chore: phase 8 complete - all dashboard features implemented"
```

---

## Checklist Final do Projeto

Ao concluir todas as 8 fases, verificar:

- [ ] Monorepo compila sem erros (`pnpm typecheck`)
- [ ] Dashboard builda sem erros (`cd apps/web && pnpm build`)
- [ ] Docker Compose valido (`docker compose config --quiet`)
- [ ] Docker Compose sobe sem erros (`docker compose up --build`)
- [ ] API responde health check (`curl localhost:3001/health`)
- [ ] Worker conecta ao Redis e inicia 4 workers
- [ ] Dashboard abre e redireciona para login
- [ ] Migrations aplicadas no Supabase
- [ ] RLS ativo em todas as tabelas
