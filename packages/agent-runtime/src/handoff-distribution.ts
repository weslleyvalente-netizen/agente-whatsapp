import type { SupabaseClient } from "@supabase/supabase-js";

type DistributeInput = { organizationId: string; conversationId: string; handoffEventId: string };
type Distribute = (db: SupabaseClient, input: DistributeInput) => Promise<string | null>;

/** A distribuição é best-effort: o handoff da Mariana nunca falha por causa dela. */
export async function safeDistribute(distribute: Distribute, db: SupabaseClient, input: DistributeInput): Promise<string | null> {
  try {
    return await distribute(db, input);
  } catch (err) {
    console.error("requestHuman: lead distribution failed (handoff preserved):", err);
    return null;
  }
}
