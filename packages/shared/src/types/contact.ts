export interface Contact {
  id: string;
  organization_id: string;
  phone: string;
  name: string | null;
  photo_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
