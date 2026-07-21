"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Inbox, Bot, Radio, Users, Settings, DollarSign } from "lucide-react";
import { OrgSwitcher } from "./org-switcher";
import { StatusLamp } from "@/components/ui/status-lamp";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Início", href: "/", icon: Home },
  { name: "Inbox", href: "/inbox", icon: Inbox },
  { name: "Agentes", href: "/agents", icon: Bot },
  { name: "Instancias", href: "/instances", icon: Radio },
  { name: "Custos", href: "/costs", icon: DollarSign },
  { name: "Equipe", href: "/team", icon: Users },
  { name: "Configuracoes", href: "/settings", icon: Settings },
];

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-64 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-2 border-b border-sidebar-border px-4 py-4">
        <StatusLamp tone="green" />
        <span className="label-eyebrow text-muted-foreground">Console online</span>
      </div>

      <div className="border-b border-sidebar-border p-3">
        <OrgSwitcher />
      </div>

      <nav className="flex-1 space-y-0.5 p-2 pl-3">
        {navigation.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "relative flex items-center gap-3 overflow-hidden rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              {isActive && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border px-4 py-3">
        <p className="label-eyebrow">aula-agente</p>
      </div>
    </aside>
  );
}
