import { createClient } from "@supabase/supabase-js";

export function createSupabaseClient(url: string, anonKey: string) {
  return createClient(url, anonKey);
}
