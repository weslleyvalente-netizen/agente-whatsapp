import type { SupabaseClient } from "@supabase/supabase-js";

type DistributeInput = { organizationId: string; conversationId: string; handoffEventId: string };
type Distribute = (db: SupabaseClient, input: DistributeInput) => Promise<string | null>;
type RecordError = (db: SupabaseClient, input: DistributeInput & { message: string }) => Promise<string | null>;

const errorMessage = (err: unknown): string =>
  (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string")
    ? (err as { message: string }).message
    : String(err);

/**
 * A distribuição é best-effort: o handoff da Mariana nunca falha por causa dela.
 * Na falha, registra a exceção distribution_error (fila do gestor) — também best-effort.
 */
export async function safeDistribute(distribute: Distribute, db: SupabaseClient, input: DistributeInput, recordError?: RecordError): Promise<string | null> {
  try {
    return await distribute(db, input);
  } catch (err) {
    console.error("requestHuman: lead distribution failed (handoff preserved):", err);
    if (recordError) {
      try {
        await recordError(db, { ...input, message: errorMessage(err) });
      } catch (recordErr) {
        console.error("requestHuman: failed to record distribution_error (handoff preserved):", recordErr);
      }
    }
    return null;
  }
}
