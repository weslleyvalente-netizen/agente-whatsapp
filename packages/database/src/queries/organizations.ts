import type { SupabaseClient } from "@supabase/supabase-js";
import type { Organization, OrganizationMember, OrganizationInvitation } from "@aula-agente/shared";

export async function getOrganizationById(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("organizations")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as Organization;
}

export async function getOrganizationBySlug(client: SupabaseClient, slug: string) {
  const { data, error } = await client
    .from("organizations")
    .select("*")
    .eq("slug", slug)
    .single();
  if (error) throw error;
  return data as Organization;
}

export async function getOrganizationMembers(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("organization_members")
    .select("*")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return data as OrganizationMember[];
}

export async function getUserOrganizations(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("organization_members")
    .select("*, organizations(*)")
    .eq("user_id", userId);
  if (error) throw error;
  return data;
}

export async function createOrganization(
  client: SupabaseClient,
  org: Pick<Organization, "name" | "slug" | "plan" | "settings">,
  userId: string
) {
  const { data: orgData, error: orgError } = await client
    .from("organizations")
    .insert(org)
    .select()
    .single();
  if (orgError) throw orgError;

  const { error: memberError } = await client.from("organization_members").insert({
    organization_id: orgData.id,
    user_id: userId,
    role: "owner",
  });
  if (memberError) throw memberError;

  return orgData as Organization;
}

export async function createInvitation(
  client: SupabaseClient,
  invitation: Pick<OrganizationInvitation, "organization_id" | "email" | "role" | "invited_by">
) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("organization_invitations")
    .insert({ ...invitation, status: "pending", expires_at: expiresAt })
    .select()
    .single();
  if (error) throw error;
  return data as OrganizationInvitation;
}
