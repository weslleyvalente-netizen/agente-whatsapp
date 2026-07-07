# Fase 4: Dashboard Auth & Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configurar o dashboard Next.js com Supabase Auth, multi-tenancy (org switcher), layout base com sidebar, e middleware de autenticacao.

**Architecture:** Next.js App Router com Supabase Auth. Middleware protege rotas do dashboard. Layout com sidebar responsiva. Org switcher permite trocar de organizacao. RLS garante isolamento de dados.

**Tech Stack:** Next.js 15, Supabase Auth, shadcn/ui, Tailwind CSS 4, Lucide Icons

**Depends on:** Fase 1 (monorepo, database package)

---

### Task 1: Inicializar Next.js App

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/tailwind.config.ts`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/globals.css`

- [ ] **Step 1: Criar Next.js app**

```bash
cd apps/web && npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack
```

- [ ] **Step 2: Atualizar package.json com nome e dependencias do workspace**

Editar `apps/web/package.json` — adicionar:
```json
{
  "name": "@aula-agente/web",
  "dependencies": {
    "@aula-agente/shared": "workspace:*",
    "@aula-agente/database": "workspace:*",
    "@supabase/ssr": "^0.5.0",
    "@supabase/supabase-js": "^2.49.0"
  }
}
```

- [ ] **Step 3: Instalar shadcn/ui**

```bash
cd apps/web && npx shadcn@latest init -d
```

- [ ] **Step 4: Adicionar componentes shadcn essenciais**

```bash
cd apps/web && npx shadcn@latest add button input label card dialog dropdown-menu avatar separator sheet sidebar tooltip badge select textarea tabs form toast sonner
```

- [ ] **Step 5: Instalar dependencias adicionais**

```bash
cd apps/web && pnpm add lucide-react
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/
git commit -m "feat(web): initialize Next.js app with shadcn/ui and tailwind"
```

---

### Task 2: Supabase Client Setup (Browser + Server + Middleware)

**Files:**
- Create: `apps/web/src/lib/supabase/client.ts`
- Create: `apps/web/src/lib/supabase/server.ts`
- Create: `apps/web/src/lib/supabase/middleware.ts`
- Create: `apps/web/src/middleware.ts`

- [ ] **Step 1: Criar client.ts (browser)**

Criar `apps/web/src/lib/supabase/client.ts`:
```typescript
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

- [ ] **Step 2: Criar server.ts (server components/actions)**

Criar `apps/web/src/lib/supabase/server.ts`:
```typescript
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Can be ignored in Server Components
          }
        },
      },
    }
  );
}
```

- [ ] **Step 3: Criar middleware.ts do supabase**

Criar `apps/web/src/lib/supabase/middleware.ts`:
```typescript
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Redirect to login if not authenticated and trying to access dashboard
  if (!user && request.nextUrl.pathname.startsWith("/(dashboard)") || 
      !user && !request.nextUrl.pathname.startsWith("/login") && 
      !request.nextUrl.pathname.startsWith("/register") &&
      !request.nextUrl.pathname.startsWith("/auth") &&
      request.nextUrl.pathname !== "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Redirect to dashboard if authenticated and on auth pages
  if (user && (request.nextUrl.pathname === "/login" || request.nextUrl.pathname === "/register")) {
    const url = request.nextUrl.clone();
    url.pathname = "/inbox";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
```

- [ ] **Step 4: Criar middleware.ts do Next.js**

Criar `apps/web/src/middleware.ts`:
```typescript
import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
```

- [ ] **Step 5: Criar .env.local.example**

Criar `apps/web/.env.local.example`:
```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_API_URL=http://localhost:3001
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/supabase/ apps/web/src/middleware.ts apps/web/.env.local.example
git commit -m "feat(web): add Supabase auth with SSR middleware"
```

---

### Task 3: Paginas de Login e Registro

**Files:**
- Create: `apps/web/src/app/(auth)/login/page.tsx`
- Create: `apps/web/src/app/(auth)/register/page.tsx`
- Create: `apps/web/src/app/(auth)/layout.tsx`
- Create: `apps/web/src/app/(auth)/auth-form.tsx`

- [ ] **Step 1: Criar layout de auth**

Criar `apps/web/src/app/(auth)/layout.tsx`:
```tsx
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40">
      <div className="w-full max-w-md px-4">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Criar componente de formulario compartilhado**

Criar `apps/web/src/app/(auth)/auth-form.tsx`:
```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface AuthFormProps {
  mode: "login" | "register";
}

export function AuthForm({ mode }: AuthFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === "register") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      router.push("/inbox");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{mode === "login" ? "Entrar" : "Criar conta"}</CardTitle>
        <CardDescription>
          {mode === "login"
            ? "Entre com seu email e senha"
            : "Crie sua conta para comecar"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Senha</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Carregando..." : mode === "login" ? "Entrar" : "Criar conta"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {mode === "login" ? (
              <>Nao tem conta? <a href="/register" className="underline">Criar conta</a></>
            ) : (
              <>Ja tem conta? <a href="/login" className="underline">Entrar</a></>
            )}
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Criar pagina de login**

Criar `apps/web/src/app/(auth)/login/page.tsx`:
```tsx
import { AuthForm } from "../auth-form";

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
```

- [ ] **Step 4: Criar pagina de registro**

Criar `apps/web/src/app/(auth)/register/page.tsx`:
```tsx
import { AuthForm } from "../auth-form";

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(auth\)/
git commit -m "feat(web): add login and register pages with Supabase Auth"
```

---

### Task 4: Organization Provider + Hook

**Files:**
- Create: `apps/web/src/hooks/use-organization.ts`
- Create: `apps/web/src/providers/organization-provider.tsx`

- [ ] **Step 1: Criar organization provider**

Criar `apps/web/src/providers/organization-provider.tsx`:
```tsx
"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Organization } from "@aula-agente/shared";

interface OrganizationContextType {
  organizations: Organization[];
  currentOrg: Organization | null;
  setCurrentOrg: (org: Organization) => void;
  loading: boolean;
  refetch: () => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextType>({
  organizations: [],
  currentOrg: null,
  setCurrentOrg: () => {},
  loading: true,
  refetch: async () => {},
});

export function OrganizationProvider({ children }: { children: React.ReactNode }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [currentOrg, setCurrentOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const fetchOrgs = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: memberships } = await supabase
      .from("organization_members")
      .select("organization_id, role, organizations(*)")
      .eq("user_id", user.id);

    if (memberships && memberships.length > 0) {
      const orgs = memberships
        .map((m) => m.organizations as unknown as Organization)
        .filter(Boolean);
      setOrganizations(orgs);

      // Restore last selected org from localStorage
      const savedOrgId = localStorage.getItem("currentOrgId");
      const savedOrg = orgs.find((o) => o.id === savedOrgId);
      setCurrentOrg(savedOrg || orgs[0]);
    }

    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchOrgs();
  }, [fetchOrgs]);

  const handleSetCurrentOrg = (org: Organization) => {
    setCurrentOrg(org);
    localStorage.setItem("currentOrgId", org.id);
  };

  return (
    <OrganizationContext.Provider
      value={{
        organizations,
        currentOrg,
        setCurrentOrg: handleSetCurrentOrg,
        loading,
        refetch: fetchOrgs,
      }}
    >
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization() {
  return useContext(OrganizationContext);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/providers/ apps/web/src/hooks/
git commit -m "feat(web): add organization provider with multi-tenancy context"
```

---

### Task 5: Dashboard Layout com Sidebar

**Files:**
- Create: `apps/web/src/app/(dashboard)/layout.tsx`
- Create: `apps/web/src/components/layout/app-sidebar.tsx`
- Create: `apps/web/src/components/layout/org-switcher.tsx`
- Create: `apps/web/src/components/layout/user-nav.tsx`

- [ ] **Step 1: Criar org-switcher**

Criar `apps/web/src/components/layout/org-switcher.tsx`:
```tsx
"use client";

import { useOrganization } from "@/providers/organization-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Building2, ChevronDown } from "lucide-react";

export function OrgSwitcher() {
  const { organizations, currentOrg, setCurrentOrg } = useOrganization();

  if (!currentOrg) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="w-full justify-between px-2">
          <span className="flex items-center gap-2 truncate">
            <Building2 className="h-4 w-4 shrink-0" />
            <span className="truncate">{currentOrg.name}</span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {organizations.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onClick={() => setCurrentOrg(org)}
            className={org.id === currentOrg.id ? "bg-accent" : ""}
          >
            <Building2 className="mr-2 h-4 w-4" />
            {org.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: Criar user-nav**

Criar `apps/web/src/components/layout/user-nav.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LogOut, User } from "lucide-react";

interface UserNavProps {
  email: string;
}

export function UserNav({ email }: UserNavProps) {
  const router = useRouter();
  const supabase = createClient();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-md p-2 hover:bg-accent">
          <Avatar className="h-8 w-8">
            <AvatarFallback>{email[0].toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="truncate text-sm">{email}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleLogout}>
          <LogOut className="mr-2 h-4 w-4" />
          Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 3: Criar app-sidebar**

Criar `apps/web/src/components/layout/app-sidebar.tsx`:
```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox, Bot, Radio, Users, Settings } from "lucide-react";
import { OrgSwitcher } from "./org-switcher";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Inbox", href: "/inbox", icon: Inbox },
  { name: "Agentes", href: "/agents", icon: Bot },
  { name: "Instancias", href: "/instances", icon: Radio },
  { name: "Equipe", href: "/team", icon: Users },
  { name: "Configuracoes", href: "/settings", icon: Settings },
];

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-background">
      <div className="border-b p-4">
        <OrgSwitcher />
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {navigation.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 4: Criar dashboard layout**

Criar `apps/web/src/app/(dashboard)/layout.tsx`:
```tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OrganizationProvider } from "@/providers/organization-provider";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { UserNav } from "@/components/layout/user-nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <OrganizationProvider>
      <div className="flex h-screen overflow-hidden">
        <AppSidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex h-14 items-center justify-end border-b px-6">
            <UserNav email={user.email!} />
          </header>
          <main className="flex-1 overflow-y-auto p-6">{children}</main>
        </div>
      </div>
    </OrganizationProvider>
  );
}
```

- [ ] **Step 5: Criar pagina placeholder do inbox**

Criar `apps/web/src/app/(dashboard)/inbox/page.tsx`:
```tsx
export default function InboxPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Inbox</h1>
      <p className="text-muted-foreground">Em breve...</p>
    </div>
  );
}
```

- [ ] **Step 6: Atualizar pagina raiz para redirecionar**

Criar `apps/web/src/app/page.tsx`:
```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/inbox");
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/
git commit -m "feat(web): add dashboard layout with sidebar, org switcher, and user nav"
```

---

### Task 6: Create Organization Flow

**Files:**
- Create: `apps/web/src/app/(dashboard)/onboarding/page.tsx`

- [ ] **Step 1: Criar pagina de onboarding (criar primeira org)**

Criar `apps/web/src/app/(dashboard)/onboarding/page.tsx`:
```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function OnboardingPage() {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();
  const { refetch } = useOrganization();

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Create organization
      const { data: org, error: orgError } = await supabase
        .from("organizations")
        .insert({
          name,
          slug,
          plan: "free",
          settings: { max_documents: 100, max_agents: 5, max_instances: 3 },
        })
        .select()
        .single();

      if (orgError) throw orgError;

      // Add user as owner
      const { error: memberError } = await supabase
        .from("organization_members")
        .insert({
          organization_id: org.id,
          user_id: user.id,
          role: "owner",
        });

      if (memberError) throw memberError;

      await refetch();
      router.push("/inbox");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar organizacao");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Criar organizacao</CardTitle>
          <CardDescription>Configure sua primeira organizacao para comecar</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Nome da organizacao</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Minha Empresa"
                required
              />
              {slug && (
                <p className="text-xs text-muted-foreground">Slug: {slug}</p>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || !name}>
              {loading ? "Criando..." : "Criar organizacao"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/onboarding/
git commit -m "feat(web): add onboarding page for creating first organization"
```

---

### Task 7: API Client Helper

**Files:**
- Create: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Criar api.ts**

Criar `apps/web/src/lib/api.ts`:
```typescript
import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function apiFetch(path: string, options: RequestInit = {}) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error || `API error: ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): add API client helper with auth token injection"
```

---

### Task 8: Realtime Hook Base

**Files:**
- Create: `apps/web/src/lib/realtime.ts`

- [ ] **Step 1: Criar realtime.ts**

Criar `apps/web/src/lib/realtime.ts`:
```typescript
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

interface UseRealtimeOptions<T> {
  table: string;
  filter?: string;
  event?: "INSERT" | "UPDATE" | "DELETE" | "*";
  onInsert?: (payload: T) => void;
  onUpdate?: (payload: T) => void;
  onDelete?: (payload: T) => void;
  enabled?: boolean;
}

export function useRealtime<T extends Record<string, unknown>>({
  table,
  filter,
  event = "*",
  onInsert,
  onUpdate,
  onDelete,
  enabled = true,
}: UseRealtimeOptions<T>) {
  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();

    const channelConfig: Record<string, string> = {
      event,
      schema: "public",
      table,
    };

    if (filter) {
      channelConfig.filter = filter;
    }

    const channel = supabase
      .channel(`realtime:${table}:${filter || "all"}`)
      .on(
        "postgres_changes" as any,
        channelConfig,
        (payload: RealtimePostgresChangesPayload<T>) => {
          if (payload.eventType === "INSERT" && onInsert) {
            onInsert(payload.new as T);
          }
          if (payload.eventType === "UPDATE" && onUpdate) {
            onUpdate(payload.new as T);
          }
          if (payload.eventType === "DELETE" && onDelete) {
            onDelete(payload.old as T);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [table, filter, event, onInsert, onUpdate, onDelete, enabled]);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/realtime.ts
git commit -m "feat(web): add realtime subscription hook for Supabase"
```

---

### Task 9: Verificacao Final da Fase 4

- [ ] **Step 1: Verificar que Next.js compila**

```bash
cd apps/web && pnpm build
```

Esperado: build completa sem erros.

- [ ] **Step 2: Testar dev server**

```bash
pnpm dev:web
# Abrir http://localhost:3000
# Expected: redireciona para /login
```

- [ ] **Step 3: Commit final**

```bash
git add -A && git status
git commit -m "chore: phase 4 final adjustments"
```
