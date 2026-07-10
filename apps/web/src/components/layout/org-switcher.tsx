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
      <DropdownMenuTrigger render={<Button variant="ghost" className="w-full justify-between px-2" />}>
        <span className="flex items-center gap-2 truncate">
          <Building2 className="h-4 w-4 shrink-0" />
          <span className="truncate">{currentOrg.name}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0" />
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
