"use client";

import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { SidebarBody } from "./app-sidebar";

/** Botão de menu + painel deslizante. Só aparece abaixo de md (celular). */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  // Se a tela crescer além de md (ex.: girar o aparelho), o painel não deve ficar aberto.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => { if (mq.matches) setOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button variant="outline" size="sm" className="h-11 shrink-0 gap-2 px-3 md:hidden" aria-label="Abrir menu" />
        }
      >
        <Menu className="h-5 w-5" />
        Menu
      </SheetTrigger>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="data-[side=left]:w-72 data-[side=left]:max-w-[85vw] sm:data-[side=left]:max-w-[85vw] gap-0 overflow-y-auto bg-sidebar p-0 pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <SidebarBody collapsed={false} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
