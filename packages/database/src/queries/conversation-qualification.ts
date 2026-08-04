import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConversationQualification,
  ConversationQualificationWriteFields,
  ConversationQualificationIdentityWrite,
} from "@aula-agente/shared";
import { encryptCpf, hashCpf } from "../crypto/cpf.js";

export async function getQualificationByConversationId(
  client: SupabaseClient,
  conversationId: string
): Promise<ConversationQualification | null> {
  const { data, error } = await client
    .from("conversation_qualifications")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw error;
  return data as ConversationQualification | null;
}

// A field counts as "written" (and gets locked) when it's present with a
// real value; writing null or "" un-locks it instead — that's how a human
// hands a field back to Helena.
export function computeLockedFields(existingLocked: string[], writtenFields: Record<string, unknown>): string[] {
  const locked = new Set(existingLocked);
  for (const [key, value] of Object.entries(writtenFields)) {
    if (value === null || value === "") {
      locked.delete(key);
    } else {
      locked.add(key);
    }
  }
  return Array.from(locked);
}

// Helena's write path: silently drop any field a human has already locked,
// rather than erroring — she just doesn't get to touch that field again
// until the human clears it.
export function filterUnlockedFields<T extends Record<string, unknown>>(
  fields: T,
  lockedFields: string[]
): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!lockedFields.includes(key)) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export function decideCpfWriteAction(
  existingHash: string | null,
  newHash: string | null
): "none" | "set" | "replace" {
  if (!newHash) return "none";
  if (!existingHash) return "set";
  if (existingHash === newHash) return "none";
  return "replace";
}

export interface UpsertQualificationParams {
  organizationId: string;
  conversationId: string;
  contactId: string;
  changedByType: "human" | "ai";
  changedById: string | null;
  fields: ConversationQualificationWriteFields;
  identity?: ConversationQualificationIdentityWrite;
}

export async function upsertConversationQualification(
  client: SupabaseClient,
  params: UpsertQualificationParams
): Promise<ConversationQualification> {
  const existing = await getQualificationByConversationId(client, params.conversationId);

  // Commercial fields: human writes apply unconditionally and lock;
  // AI writes are filtered against the existing lock list first.
  const commercialWrites =
    params.changedByType === "human"
      ? params.fields
      : filterUnlockedFields(params.fields as Record<string, unknown>, existing?.human_locked_fields ?? []);

  const nextLockedFields =
    params.changedByType === "human"
      ? computeLockedFields(existing?.human_locked_fields ?? [], params.fields as Record<string, unknown>)
      : existing?.human_locked_fields ?? [];

  // Identity fields: replace-and-audit, independent of human_locked_fields.
  const identityWrites: Record<string, unknown> = {};
  let cpfAction: "none" | "set" | "replace" = "none";
  if (params.identity?.cpf) {
    const newHash = hashCpf(params.identity.cpf);
    cpfAction = decideCpfWriteAction(existing?.cpf_hash ?? null, newHash);
    if (cpfAction === "set" || cpfAction === "replace") {
      identityWrites.cpf_encrypted = encryptCpf(params.identity.cpf);
      identityWrites.cpf_hash = newHash;
      identityWrites.birth_date = params.identity.birth_date ?? null;
      identityWrites.has_driver_license = params.identity.has_driver_license ?? null;
      identityWrites.driver_license_category = params.identity.driver_license_category ?? null;
    }
  }

  const writePayload = {
    ...commercialWrites,
    ...identityWrites,
    human_locked_fields: nextLockedFields,
  };

  let qualification: ConversationQualification;
  if (existing) {
    const { data, error } = await client
      .from("conversation_qualifications")
      .update(writePayload)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw error;
    qualification = data as ConversationQualification;
  } else {
    const { data, error } = await client
      .from("conversation_qualifications")
      .insert({
        organization_id: params.organizationId,
        conversation_id: params.conversationId,
        contact_id: params.contactId,
        ...writePayload,
      })
      .select()
      .single();
    if (error) throw error;
    qualification = data as ConversationQualification;
  }

  const hasCommercialWrites = Object.keys(commercialWrites).length > 0;
  if (hasCommercialWrites) {
    const { error: eventError } = await client.from("conversation_qualification_events").insert({
      organization_id: params.organizationId,
      conversation_qualification_id: qualification.id,
      event_type: "field_updated",
      changed_fields: commercialWrites,
      changed_by_type: params.changedByType,
      changed_by_id: params.changedById,
    });
    if (eventError) throw eventError;
  }

  if (cpfAction === "replace") {
    const { error: cpfEventError } = await client.from("conversation_qualification_events").insert({
      organization_id: params.organizationId,
      conversation_qualification_id: qualification.id,
      event_type: "cpf_replaced",
      changed_fields: { previous_hash: existing?.cpf_hash ?? null, new_hash: identityWrites.cpf_hash },
      changed_by_type: params.changedByType,
      changed_by_id: params.changedById,
    });
    if (cpfEventError) throw cpfEventError;
  }

  return qualification;
}
