"use client";

import { useOrganization } from "@/providers/organization-provider";

export function useWhatsappLayout(): boolean {
  return useOrganization().currentOrg?.settings.inbox_whatsapp_layout_enabled === true;
}
