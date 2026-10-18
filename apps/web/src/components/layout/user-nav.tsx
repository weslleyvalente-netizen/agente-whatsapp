"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { unsubscribeThisDeviceOnLogout } from "@/lib/push-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bell, LogOut } from "lucide-react";
import { USER_MENU_LINKS } from "./user-menu-items";

interface UserNavProps {
  email: string;
}

export function UserNav({ email }: UserNavProps) {
  const router = useRouter();
  const supabase = createClient();

  const handleLogout = async () => {
    // Antes do signOut (o POST precisa do token): este aparelho não pode continuar recebendo os avisos de quem saiu.
    await unsubscribeThisDeviceOnLogout();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Conta e sair" className="flex items-center gap-2 rounded-md p-1 md:p-2 hover:bg-accent">
        <Avatar className="h-8 w-8">
          <AvatarFallback>{email[0].toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="hidden truncate text-sm md:inline">{email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {USER_MENU_LINKS.map((link) => (
          <DropdownMenuItem key={link.href} onClick={() => router.push(link.href)}>
            <Bell className="mr-2 h-4 w-4" />
            {link.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={handleLogout}>
          <LogOut className="mr-2 h-4 w-4" />
          Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
