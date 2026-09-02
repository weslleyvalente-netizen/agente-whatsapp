export interface Contact {
  id: string;
  organization_id: string;
  phone: string;
  name: string | null;
  photo_url: string | null;
  metadata: Record<string, unknown>;
  // Added by migration 00021 — "Desativar IA permanentemente" in the inbox.
  ai_disabled: boolean;
  ai_disabled_at: string | null;
  ai_disabled_by: string | null;
  created_at: string;
  updated_at: string;
}
