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
