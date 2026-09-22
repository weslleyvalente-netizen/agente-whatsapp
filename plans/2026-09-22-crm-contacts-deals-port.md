# Portar Contatos e Funil de Vendas do CRM para apps/web — Implementation Plan

> **STATUS (2026-09-22): PAUSADO / Task 2 (Funil de vendas) SUPERADO.**
> Depois de escrever este plano, descobrimos que a Oportunidade comercial
> deveria nascer nativa no `aula-agente` (ver
> `specs/2026-09-22-oportunidades-comerciais-design.md`), não apontar para o
> `deals` desconectado do CRM standalone. **Task 1 (Contatos) continua
> válido como está** — a tela de Contatos não tem esse problema, `contacts`
> não precisa virar uma entidade nova. **Task 2 (Funil de vendas) não deve
> ser implementado como escrito** — a Fase 1 da spec de Oportunidades cobre
> o equivalente certo (Kanban sobre `opportunities`, não `deals`). Antes de
> executar qualquer coisa deste arquivo, confirmar com o usuário se Task 1
> ainda é prioridade isolada ou se entra junto da Fase 1 da spec nova.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar as telas "Contatos" e "Funil de vendas" dentro de `apps/web` (aula-agente), lendo/escrevendo as mesmas tabelas Supabase que o CRM standalone (`assistente-mt`) já usa, com login único (mesmo Supabase Auth) e corrigindo o bug do UUID cru no seletor de responsável.

**Architecture:** Cópia adaptada dos componentes React de `/Users/weslleyvalente/assistente-mt` para `/Users/weslleyvalente/Agente IA/superpowers/apps/web`, sem nenhuma migração de banco — as páginas novas leem/escrevem diretamente `contacts`, `deals`, `profiles` (schema do CRM, inalterado). Duas rotas novas em `src/app/(dashboard)/`, herdando a autenticação já existente no layout. Dois itens novos no menu lateral (`AppSidebar`).

**Tech Stack:** Next.js (App Router), Supabase (`@supabase/ssr`), `@base-ui/react` (kit de UI, já usado nos dois apps), `react-hook-form` + `zod` (validação de formulário), `@dnd-kit/core` (drag-and-drop do Kanban — dependência nova para `apps/web`).

**Spec:** [`specs/2026-09-22-crm-integration-design.md`](../specs/2026-09-22-crm-integration-design.md)

## Global Constraints

- Nenhuma migração de banco. Nenhuma tabela nova. As páginas lêem/escrevem `contacts`, `deals`, `profiles` exatamente como estão hoje.
- A tabela `activities` (CRM) **não é portada** — tarefas continuam vindo de `tasks`, que já existe em `apps/web`. Não criar nenhuma UI para `activities` aqui.
- RLS das tabelas `contacts`/`deals`/`profiles` não muda: continua `is_active_profile(auth.uid())`. Não escrever policy nova.
- Mesmo kit de UI dos dois apps (`@base-ui/react`, `components/ui/*`) — não trocar por outra lib de componentes.
- `apps/web` não tem framework de teste automatizado configurado hoje (sem `vitest`/`jest`, sem arquivos `*.test.ts`) — diferente de `apps/api`, que tem. Verificação aqui é manual, via `pnpm dev` + clique na UI, seguindo o padrão já existente do próprio app. Não introduzir um framework de teste novo como parte deste plano.
- `crm-sync.ts` (`apps/api/src/integrations/crm-sync.ts`) não é tocado — continua escrevendo em `contacts`/`activities` exatamente como já faz.

## Review Focus

- Negócio com `owner_id` apontando para um perfil que não existe mais (excluído, não só inativo) — o `AssigneeSelect` não pode quebrar a página, só mostrar sem nome resolvido.
- `/contacts` e `/deals` com zero linhas — tabela e Kanban precisam renderizar vazios sem erro (não só com os 929 contatos/1 negócio reais de hoje).
- Contato com `email`/`phone`/`company` nulos (schema permite) — célula da tabela deve ficar em branco, não mostrar a string `"null"`.
- Erro do Supabase em qualquer mutação (criar/editar/excluir contato, criar negócio, trocar responsável, arrastar estágio) precisa continuar aparecendo via `alert(error.message)`, igual ao comportamento original — não pode falhar silenciosamente depois da portagem.
- Transição de estágio inválida no Kanban (ex: arrastar de "novo" direto para "fechado_ganho") precisa continuar bloqueada por `canTransition()` — não pode virar um `no-op` silencioso nem quebrar, e o guard não pode ser perdido na cópia.

---

## Task 1: Página de Contatos

**Files:**
- Create: `apps/web/src/lib/validations/contact.ts`
- Create: `apps/web/src/components/ui/table.tsx`
- Create: `apps/web/src/components/contacts/contact-form.tsx`
- Create: `apps/web/src/components/contacts/delete-contact-button.tsx`
- Create: `apps/web/src/app/(dashboard)/contacts/page.tsx`
- Modify: `apps/web/src/components/layout/app-sidebar.tsx`

**Interfaces:**
- Consumes: `createClient` de `@/lib/supabase/server` (server) e `@/lib/supabase/client` (client) — já existem em `apps/web`, mesma assinatura usada em `assistente-mt`. `cn` de `@/lib/utils` — já existe.
- Produces: rota `/contacts`, item de menu "Contatos". Tabela `contacts` (colunas `id, name, email, phone, company`) — consumida só por esta task.

- [ ] **Step 1: Criar o schema de validação de contato**

Criar `apps/web/src/lib/validations/contact.ts`:

```ts
import { z } from "zod";

export const contactSchema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  email: z.string().email("E-mail inválido").optional().or(z.literal("")),
  phone: z.string().optional(),
  company: z.string().optional(),
});

export type ContactInput = z.infer<typeof contactSchema>;
```

- [ ] **Step 2: Criar o primitivo de tabela (`components/ui/table.tsx`)**

`apps/web` ainda não tem esse componente de UI (usado pela lista de contatos). Copiar de `assistente-mt/components/ui/table.tsx` para `apps/web/src/components/ui/table.tsx`, sem alterações:

```tsx
"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
```

- [ ] **Step 3: Criar o formulário de contato (criar/editar)**

Criar `apps/web/src/components/contacts/contact-form.tsx`, copiado de `assistente-mt/components/contact-form.tsx` sem mudança de lógica (só a localização do arquivo — os imports `@/...` continuam resolvendo do mesmo jeito):

```tsx
"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { contactSchema, type ContactInput } from "@/lib/validations/contact";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type Contact = ContactInput & { id: string };

export function ContactForm({ contact, onSaved }: { contact?: Contact; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ContactInput>({ resolver: zodResolver(contactSchema), defaultValues: contact });

  useEffect(() => {
    if (open) {
      reset(contact ?? { name: "", email: "", phone: "", company: "" });
    }
  }, [open, contact, reset]);

  async function onSubmit(values: ContactInput) {
    const supabase = createClient();
    const payload = { ...values, email: values.email || null };

    const { error } = contact
      ? await supabase.from("contacts").update(payload).eq("id", contact.id)
      : await supabase.from("contacts").insert(payload);

    if (error) {
      alert(error.message);
      return;
    }

    setOpen(false);
    onSaved?.();
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={contact ? "outline" : "default"} size={contact ? "sm" : "default"} />}>
        {contact ? "Editar" : "Novo contato"}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{contact ? "Editar contato" : "Novo contato"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div>
            <Label htmlFor="name">Nome</Label>
            <Input id="name" {...register("name")} />
            {errors.name && <p className="text-sm text-red-600">{errors.name.message}</p>}
          </div>
          <div>
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" {...register("email")} />
            {errors.email && <p className="text-sm text-red-600">{errors.email.message}</p>}
          </div>
          <div>
            <Label htmlFor="phone">Telefone</Label>
            <Input id="phone" {...register("phone")} />
          </div>
          <div>
            <Label htmlFor="company">Empresa</Label>
            <Input id="company" {...register("company")} />
          </div>
          <Button type="submit" disabled={isSubmitting} className="w-full">
            Salvar
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Criar o botão de excluir contato**

Criar `apps/web/src/components/contacts/delete-contact-button.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export function DeleteContactButton({ id }: { id: string }) {
  const router = useRouter();

  async function handleDelete() {
    if (!confirm("Excluir este contato?")) return;
    const supabase = createClient();
    const { error } = await supabase.from("contacts").delete().eq("id", id);
    if (error) {
      alert(error.message);
      return;
    }
    router.refresh();
  }

  return (
    <Button variant="destructive" size="sm" onClick={handleDelete}>
      Excluir
    </Button>
  );
}
```

- [ ] **Step 5: Criar a página de Contatos**

Criar `apps/web/src/app/(dashboard)/contacts/page.tsx`:

```tsx
import { createClient } from "@/lib/supabase/server";
import { ContactForm } from "@/components/contacts/contact-form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeleteContactButton } from "@/components/contacts/delete-contact-button";

export default async function ContactsPage() {
  const supabase = await createClient();
  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, name, email, phone, company")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Contatos</h1>
        <ContactForm />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nome</TableHead>
            <TableHead>E-mail</TableHead>
            <TableHead>Telefone</TableHead>
            <TableHead>Empresa</TableHead>
            <TableHead>Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(contacts ?? []).map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.name}</TableCell>
              <TableCell>{c.email}</TableCell>
              <TableCell>{c.phone}</TableCell>
              <TableCell>{c.company}</TableCell>
              <TableCell className="flex gap-2">
                <ContactForm contact={c} />
                <DeleteContactButton id={c.id} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

Nota (Review Focus — células nulas): `email`/`phone`/`company` podem ser `null` no banco. `<TableCell>{c.email}</TableCell>` com valor `null` renderiza vazio no React (não a string `"null"`), então nenhuma tratativa extra é necessária — só confirmar isso visualmente no Step 7.

- [ ] **Step 6: Adicionar "Contatos" ao menu lateral**

Em `apps/web/src/components/layout/app-sidebar.tsx`, adicionar `Contact` aos imports do `lucide-react` e um item logo após "Conversas":

```tsx
import {
  Home,
  Inbox,
  Contact,
  Bot,
  Radio,
  Users,
  Settings,
  DollarSign,
  ListChecks,
  ShoppingBag,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
```

```tsx
const navigation = [
  { name: "Início", href: "/", icon: Home },
  { name: "Conversas", href: "/inbox", icon: Inbox },
  { name: "Contatos", href: "/contacts", icon: Contact },
  { name: "Tarefas", href: "/tasks", icon: ListChecks },
  { name: "Catálogo", href: "/catalog", icon: ShoppingBag },
  { name: "Agentes", href: "/agents", icon: Bot },
  { name: "Instancias", href: "/instances", icon: Radio },
  { name: "Custos", href: "/costs", icon: DollarSign },
  { name: "Equipe", href: "/team", icon: Users },
  { name: "Configuracoes", href: "/settings", icon: Settings },
];
```

- [ ] **Step 7: Verificar manualmente**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
pnpm --filter @aula-agente/web dev
```

Abrir `http://localhost:3000/contacts` no navegador, logado com a mesma conta usada no CRM standalone. Confirmar:
- A lista carrega com os contatos reais (deve bater com os 929 vistos no CRM standalone).
- Linhas com `email`/`phone`/`company` vazios no banco aparecem em branco, não com o texto `null`.
- "Novo contato" cria uma linha nova (conferir que aparece também no CRM standalone, já que é a mesma tabela).
- "Editar" abre o formulário preenchido e salva.
- "Excluir" pede confirmação e remove a linha.
- O item "Contatos" aparece no menu, entre "Conversas" e "Tarefas", com o ícone certo.

- [ ] **Step 8: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
git add apps/web/src/lib/validations/contact.ts \
  apps/web/src/components/ui/table.tsx \
  apps/web/src/components/contacts/contact-form.tsx \
  apps/web/src/components/contacts/delete-contact-button.tsx \
  "apps/web/src/app/(dashboard)/contacts/page.tsx" \
  apps/web/src/components/layout/app-sidebar.tsx
git commit -m "feat(web): add Contatos page, ported from the CRM"
```

---

## Task 2: Página de Funil de vendas (Deals Kanban)

**Files:**
- Modify: `apps/web/package.json` (adicionar `@dnd-kit/core`)
- Create: `apps/web/src/lib/deals/stage-transitions.ts`
- Create: `apps/web/src/lib/validations/deal.ts`
- Create: `apps/web/src/components/deals/assignee-select.tsx`
- Create: `apps/web/src/components/deals/deal-kanban.tsx`
- Create: `apps/web/src/components/deals/deal-form.tsx`
- Create: `apps/web/src/app/(dashboard)/deals/page.tsx`
- Modify: `apps/web/src/components/layout/app-sidebar.tsx`

**Interfaces:**
- Consumes: `createClient` (server/client), `cn` — mesmos de Task 1. Tabela `contacts` (só `id, name`, para o seletor de contato do formulário) — já existe desde Task 1, sem mudança.
- Produces: rota `/deals`, item de menu "Funil de vendas". `AssigneeSelect` fica em `@/components/deals/assignee-select` (não compartilhado com Task 1 — só o Kanban e o formulário de negócio usam).

- [ ] **Step 1: Adicionar a dependência `@dnd-kit/core`**

`apps/web/package.json` ainda não tem essa lib (usada pelo drag-and-drop do Kanban). Adicionar ao `dependencies`, na mesma versão já usada em `assistente-mt`:

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers/apps/web"
pnpm add @dnd-kit/core@^6.3.1
```

- [ ] **Step 2: Criar os estágios e a validação de transição do funil**

Criar `apps/web/src/lib/deals/stage-transitions.ts`:

```ts
export const DEAL_STAGES = [
  "novo",
  "em_contato",
  "negociacao",
  "fechado_ganho",
  "fechado_perdido",
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

const ALLOWED_TRANSITIONS: Record<DealStage, DealStage[]> = {
  novo: ["em_contato"],
  em_contato: ["negociacao"],
  negociacao: ["fechado_ganho", "fechado_perdido"],
  fechado_ganho: [],
  fechado_perdido: [],
};

export function canTransition(from: DealStage, to: DealStage): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
```

- [ ] **Step 3: Criar o schema de validação de negócio**

Criar `apps/web/src/lib/validations/deal.ts`:

```ts
import { z } from "zod";
import { DEAL_STAGES } from "@/lib/deals/stage-transitions";

export const dealSchema = z.object({
  contact_id: z.string().uuid("Selecione um contato"),
  title: z.string().min(1, "Título é obrigatório"),
  value: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().nonnegative().optional()
  ),
  owner_id: z.string().uuid().optional().or(z.literal("")),
});

export type DealInput = z.infer<typeof dealSchema>;

export const DEAL_STAGE_LABELS: Record<(typeof DEAL_STAGES)[number], string> = {
  novo: "Novo",
  em_contato: "Em contato",
  negociacao: "Negociação",
  fechado_ganho: "Fechado (ganho)",
  fechado_perdido: "Fechado (perdido)",
};
```

- [ ] **Step 4: Criar o `AssigneeSelect` já com a correção do bug do UUID cru**

Criar `apps/web/src/components/deals/assignee-select.tsx`. Diferença em relação ao original do CRM standalone: depois de buscar os perfis ativos, se o `value` atual não estiver entre eles (perfil inativo ou não carregado ainda), busca esse perfil específico por `id` e inclui na lista com um marcador "(inativo)" — assim o `Select` sempre encontra uma opção correspondente e nunca cai no fallback de mostrar o UUID cru:

```tsx
"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Member = { id: string; full_name: string | null; email: string | null; is_active: boolean };

export function AssigneeSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    async function load() {
      const { data: active } = await supabase
        .from("profiles")
        .select("id, full_name, email, is_active")
        .eq("is_active", true)
        .order("full_name");

      let list = active ?? [];

      if (value && !list.some((m) => m.id === value)) {
        const { data: current } = await supabase
          .from("profiles")
          .select("id, full_name, email, is_active")
          .eq("id", value)
          .maybeSingle();
        if (current) list = [...list, current];
      }

      if (!cancelled) setMembers(list);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [value]);

  return (
    <Select value={value ?? null} onValueChange={(v) => onChange(v)}>
      <SelectTrigger>
        <SelectValue placeholder="Atribuir a..." />
      </SelectTrigger>
      <SelectContent>
        {members.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {(m.full_name ?? m.email ?? "Sem nome") + (m.is_active ? "" : " (inativo)")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

Nota (Review Focus — perfil excluído): se `owner_id` apontar para um `id` que não existe mais em `profiles`, a busca por `id` no `maybeSingle()` retorna `data: null` — `current` fica `null`, o `if (current)` não adiciona nada, e a lista simplesmente não inclui essa opção. O `Select` mostra o placeholder "Atribuir a..." em vez de travar — sem erro, sem UUID cru.

- [ ] **Step 5: Criar o Kanban de negócios**

Criar `apps/web/src/components/deals/deal-kanban.tsx`:

```tsx
"use client";

import { DndContext, type DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DEAL_STAGES, type DealStage, canTransition } from "@/lib/deals/stage-transitions";
import { DEAL_STAGE_LABELS } from "@/lib/validations/deal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AssigneeSelect } from "@/components/deals/assignee-select";

type Deal = {
  id: string;
  title: string;
  value: number | null;
  stage: DealStage;
  owner_id: string | null;
};

function DealCard({ deal }: { deal: Deal }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: deal.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  const router = useRouter();

  async function handleOwnerChange(ownerId: string | null) {
    const supabase = createClient();
    const { error } = await supabase.from("deals").update({ owner_id: ownerId }).eq("id", deal.id);
    if (error) {
      alert(error.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="mb-2">
      <div ref={setNodeRef} style={style} {...listeners} {...attributes} className="cursor-grab">
        <Card>
          <CardContent className="p-3 text-sm">
            <p className="font-medium">{deal.title}</p>
            {deal.value != null && <p className="text-muted-foreground">R$ {deal.value}</p>}
          </CardContent>
        </Card>
      </div>
      <div className="mt-1" onPointerDown={(e) => e.stopPropagation()}>
        <AssigneeSelect value={deal.owner_id} onChange={handleOwnerChange} />
      </div>
    </div>
  );
}

function StageColumn({ stage, deals }: { stage: DealStage; deals: Deal[] }) {
  const { setNodeRef } = useDroppable({ id: stage });
  return (
    <div ref={setNodeRef} className="w-64 shrink-0">
      <Card>
        <CardHeader className="p-3">
          <CardTitle className="text-sm">{DEAL_STAGE_LABELS[stage]}</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {deals.map((d) => (
            <DealCard key={d.id} deal={d} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function DealKanban({ deals }: { deals: Deal[] }) {
  const router = useRouter();

  async function handleDragEnd(event: DragEndEvent) {
    const dealId = String(event.active.id);
    const targetStage = event.over?.id as DealStage | undefined;
    if (!targetStage) return;

    const deal = deals.find((d) => d.id === dealId);
    if (!deal || !canTransition(deal.stage, targetStage)) return;

    const supabase = createClient();
    const { error } = await supabase
      .from("deals")
      .update({ stage: targetStage })
      .eq("id", dealId);

    if (error) {
      alert(error.message);
      return;
    }
    router.refresh();
  }

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="flex gap-4 overflow-x-auto">
        {DEAL_STAGES.map((stage) => (
          <StageColumn key={stage} stage={stage} deals={deals.filter((d) => d.stage === stage)} />
        ))}
      </div>
    </DndContext>
  );
}
```

Nota (Review Focus — transição inválida): o guard `if (!deal || !canTransition(deal.stage, targetStage)) return;` em `handleDragEnd` é o que bloqueia mover um card pra um estágio não permitido (ex: "novo" → "fechado_ganho" direto). Confirmar no Step 8 que esse guard veio junto na cópia.

- [ ] **Step 6: Criar o formulário de novo negócio**

Criar `apps/web/src/components/deals/deal-form.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/client";
import { dealSchema, type DealInput } from "@/lib/validations/deal";
import { AssigneeSelect } from "@/components/deals/assignee-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type Contact = { id: string; name: string };

// react-hook-form types the form state from the schema's *input* shape (pre-coercion),
// since `value` uses z.coerce.number(); DealInput (z.infer, the post-coercion output) is
// only used for the onSubmit payload.
type DealFormValues = z.input<typeof dealSchema>;

const BLANK_VALUES: DealFormValues = {
  contact_id: "",
  title: "",
  value: undefined,
  owner_id: "",
};

export function DealForm() {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const router = useRouter();
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<DealFormValues, unknown, DealInput>({
    resolver: zodResolver(dealSchema),
    defaultValues: BLANK_VALUES,
  });

  useEffect(() => {
    if (!open) return;
    reset(BLANK_VALUES);
    const supabase = createClient();
    supabase
      .from("contacts")
      .select("id, name")
      .then(({ data }) => setContacts(data ?? []));
  }, [open, reset]);

  async function onSubmit(values: DealInput) {
    const supabase = createClient();
    const { error } = await supabase.from("deals").insert({
      contact_id: values.contact_id,
      title: values.title,
      value: values.value ?? null,
      owner_id: values.owner_id || null,
    });

    if (error) {
      alert(error.message);
      return;
    }

    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Novo negócio</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo negócio</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div>
            <Label htmlFor="title">Título</Label>
            <Input id="title" {...register("title")} />
            {errors.title && <p className="text-sm text-red-600">{errors.title.message}</p>}
          </div>
          <div>
            <Label>Contato</Label>
            <Controller
              control={control}
              name="contact_id"
              render={({ field }) => (
                <Select value={field.value || null} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione um contato" />
                  </SelectTrigger>
                  <SelectContent>
                    {contacts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.contact_id && <p className="text-sm text-red-600">{errors.contact_id.message}</p>}
          </div>
          <div>
            <Label htmlFor="value">Valor</Label>
            <Input id="value" type="number" step="0.01" {...register("value")} />
            {errors.value && <p className="text-sm text-red-600">{errors.value.message}</p>}
          </div>
          <div>
            <Label>Responsável</Label>
            <Controller
              control={control}
              name="owner_id"
              render={({ field }) => (
                <AssigneeSelect value={field.value || null} onChange={(id) => field.onChange(id ?? "")} />
              )}
            />
            {errors.owner_id && <p className="text-sm text-red-600">{errors.owner_id.message}</p>}
          </div>
          <Button type="submit" disabled={isSubmitting} className="w-full">
            Salvar
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 7: Criar a página do Funil de vendas**

Criar `apps/web/src/app/(dashboard)/deals/page.tsx`:

```tsx
import { createClient } from "@/lib/supabase/server";
import { DealKanban } from "@/components/deals/deal-kanban";
import { DealForm } from "@/components/deals/deal-form";

export default async function DealsPage() {
  const supabase = await createClient();
  const { data: deals } = await supabase
    .from("deals")
    .select("id, title, value, stage, owner_id")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Funil de vendas</h1>
        <DealForm />
      </div>
      <DealKanban deals={deals ?? []} />
    </div>
  );
}
```

- [ ] **Step 8: Adicionar "Funil de vendas" ao menu lateral**

Em `apps/web/src/components/layout/app-sidebar.tsx`, adicionar `Kanban` aos imports do `lucide-react` e o item logo depois de "Contatos":

```tsx
import {
  Home,
  Inbox,
  Contact,
  Kanban,
  Bot,
  Radio,
  Users,
  Settings,
  DollarSign,
  ListChecks,
  ShoppingBag,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
```

```tsx
const navigation = [
  { name: "Início", href: "/", icon: Home },
  { name: "Conversas", href: "/inbox", icon: Inbox },
  { name: "Contatos", href: "/contacts", icon: Contact },
  { name: "Funil de vendas", href: "/deals", icon: Kanban },
  { name: "Tarefas", href: "/tasks", icon: ListChecks },
  { name: "Catálogo", href: "/catalog", icon: ShoppingBag },
  { name: "Agentes", href: "/agents", icon: Bot },
  { name: "Instancias", href: "/instances", icon: Radio },
  { name: "Custos", href: "/costs", icon: DollarSign },
  { name: "Equipe", href: "/team", icon: Users },
  { name: "Configuracoes", href: "/settings", icon: Settings },
];
```

- [ ] **Step 9: Verificar manualmente**

Com `pnpm --filter @aula-agente/web dev` ainda rodando (Task 1), abrir `http://localhost:3000/deals`. Confirmar:
- O Kanban carrega com o negócio real "INSS" (R$ 20300) na coluna "Novo".
- O seletor de responsável do card "INSS" **não mostra mais o UUID cru** — mostra um nome (ou "(inativo)" junto do nome, se for o caso), ou o placeholder "Atribuir a..." se o perfil foi excluído de vez.
- Arrastar o card "INSS" de "Novo" para "Em contato" funciona e persiste (recarregar a página confirma).
- Tentar arrastar (via drag) diretamente de uma coluna não-adjacente é bloqueado (ex: não é possível ir de "Novo" pra "Fechado (ganho)" sem passar pelos estágios intermediários).
- "Novo negócio" cria um negócio novo, aparece na coluna "Novo".
- Erro proposital (ex: desconectar a internet e tentar arrastar um card) mostra um `alert()` com a mensagem de erro, não falha silenciosamente.
- O item "Funil de vendas" aparece no menu, com o ícone certo, entre "Contatos" e "Tarefas".
- As telas que já existiam (`/`, `/inbox`, `/tasks`, `/catalog`, `/agents`, `/instances`, `/costs`, `/team`, `/settings`) continuam funcionando normalmente — nada quebrou.

- [ ] **Step 10: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
git add apps/web/package.json apps/web/pnpm-lock.yaml \
  apps/web/src/lib/deals/stage-transitions.ts \
  apps/web/src/lib/validations/deal.ts \
  apps/web/src/components/deals/assignee-select.tsx \
  apps/web/src/components/deals/deal-kanban.tsx \
  apps/web/src/components/deals/deal-form.tsx \
  "apps/web/src/app/(dashboard)/deals/page.tsx" \
  apps/web/src/components/layout/app-sidebar.tsx
git commit -m "feat(web): add Funil de vendas (deals Kanban) page, fix stale-owner UUID bug"
```

---

## Depois das duas tasks

Nada é deployado automaticamente — Push para `main` não dispara deploy no EasyPanel (ver `docs/operations/deployment.md`). Depois que o usuário validar as duas telas localmente, o deploy do serviço `web` (projeto `agente-whatsapp`) é manual, pelo painel do EasyPanel — fora do escopo deste plano, decisão do usuário quando estiver pronto.
