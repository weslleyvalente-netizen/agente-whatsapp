"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Inbox,
  Bot,
  Radio,
  Users,
  Settings,
  DollarSign,
  ListChecks,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { OrgSwitcher } from "./org-switcher";
import { StatusLamp } from "@/components/ui/status-lamp";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Início", href: "/", icon: Home },
  { name: "Conversas", href: "/inbox", icon: Inbox },
  { name: "Tarefas", href: "/tasks", icon: ListChecks },
  { name: "Agentes", href: "/agents", icon: Bot },
  { name: "Instancias", href: "/instances", icon: Radio },
  { name: "Custos", href: "/costs", icon: DollarSign },
  { name: "Equipe", href: "/team", icon: Users },
  { name: "Configuracoes", href: "/settings", icon: Settings },
];

const COLLAPSED_STORAGE_KEY = "aula-agente-sidebar-collapsed";

export function AppSidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Read the saved preference after mount only — reading localStorage
  // during the initial render would mismatch the server-rendered markup
  // (always expanded) and trigger a hydration error.
  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true");
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
      return next;
    });
  };

  return (
    <aside
      className={cn(
        "flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <div className="flex items-center gap-2 border-b border-sidebar-border px-4 py-4">
        <StatusLamp tone="green" />
        {!collapsed && <span className="label-eyebrow text-muted-foreground">Console online</span>}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6 shrink-0"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </Button>
      </div>

      {!collapsed && (
        <div className="border-b border-sidebar-border p-3">
          <OrgSwitcher />
        </div>
      )}

      <nav className="flex-1 space-y-0.5 p-2 pl-3">
        {navigation.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              title={collapsed ? item.name : undefined}
              className={cn(
                "relative flex items-center gap-3 overflow-hidden rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              {isActive && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
              <item.icon className="h-4 w-4 shrink-0" />
              {!collapsed && item.name}
            </Link>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="border-t border-sidebar-border px-4 py-3">
          <p className="label-eyebrow">aula-agente</p>
        </div>
      )}
    </aside>
  );
}
