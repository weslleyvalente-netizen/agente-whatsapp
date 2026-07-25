import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Re-exported so CJS consumers (apps/api has no "type": "module") get the
// same nominal SupabaseClient type as this ESM package — importing the type
// directly from @supabase/supabase-js on the CJS side resolves to a
// structurally-identical but nominally distinct declaration under NodeNext
// (its dual CJS/ESM entry points), which TS rejects at any call site here
// that takes a SupabaseClient parameter (protected `supabaseUrl` member).
export type { SupabaseClient };

let adminClient: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  adminClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return adminClient;
}
