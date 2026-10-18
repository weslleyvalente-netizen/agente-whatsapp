"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeft } from "lucide-react";
import { OrgSwitcher } from "./org-switcher";
import { StatusLamp } from "@/components/ui/status-lamp";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMyRole } from "@/components/lead-distribution/use-my-role";
import { isManagerRole } from "@/lib/route-access";
import { visibleNavigation } from "./nav-items";

const COLLAPSED_STORAGE_KEY = "moto-e-trilha-sidebar-collapsed";

/** Corpo do menu, compartilhado entre a barra lateral (computador) e o painel do celular. */
export function SidebarBody({
  collapsed,
  onToggleCollapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { role } = useMyRole({ always: true });
  const isManager = isManagerRole(role);
  return (
    <>
      <div className="flex items-center gap-2 border-b border-sidebar-border px-4 py-4">
        <StatusLamp tone="green" />
        {!collapsed && <span className="label-eyebrow text-muted-foreground">Online</span>}
        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-6 w-6 shrink-0"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
          >
            {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>
        )}
      </div>

      <div className={cn("flex justify-center border-b border-sidebar-border bg-white", collapsed ? "p-1.5" : "px-4 py-3")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-moto-e-trilha.png" alt="Moto e Trilha Veículos" className={collapsed ? "h-9 w-9 object-cover object-top" : "h-24 w-auto"} />
      </div>

      {!collapsed && (
        <div className="border-b border-sidebar-border p-3">
          <OrgSwitcher />
        </div>
      )}

      <nav className="flex-1 space-y-0.5 p-2 pl-3">
        {visibleNavigation(isManager).map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              title={collapsed ? item.name : undefined}
              onClick={onNavigate}
              className={cn(
                "relative flex items-center gap-3 overflow-hidden rounded-md px-3 py-3 text-sm md:py-2 font-medium transition-colors",
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
          <p className="label-eyebrow">Moto e Trilha Veículos</p>
        </div>
      )}
    </>
  );
}

export function AppSidebar() {
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
        "hidden h-screen flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 md:flex",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <SidebarBody collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
    </aside>
  );
}
