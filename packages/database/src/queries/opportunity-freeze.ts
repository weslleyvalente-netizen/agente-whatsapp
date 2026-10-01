import type { SupabaseClient } from "@supabase/supabase-js";
import type { Opportunity } from "@aula-agente/shared";
export async function freezeOpportunity(db:SupabaseClient, input:{organizationId:string;opportunityId:string;actorId:string;date:string|null;reason:string}):Promise<Opportunity>{
 const {data,error}=await db.rpc("set_opportunity_freeze",{p_organization_id:input.organizationId,p_opportunity_id:input.opportunityId,p_actor_id:input.actorId,p_until:input.date,p_reason:input.reason});
 if(error) throw error;
 return data as Opportunity;
}

export async function hasFrozenContact(db:SupabaseClient,organizationId:string,contactId:string,includeDue=false,today=new Date().toLocaleDateString("en-CA",{timeZone:"America/Sao_Paulo"})):Promise<boolean>{
 const {data,error}=await db.from("opportunities").select("*").eq("organization_id",organizationId).eq("contact_id",contactId).eq("status","open");
 if(error)throw error;
 return (data??[]).some(o=>o.frozen_until && (includeDue || o.frozen_until>today));
}

export async function shouldCancelPreFreezeAgentMessage(db:SupabaseClient,organizationId:string,contactId:string,messageCreatedAt:string):Promise<boolean>{
 const {data,error}=await db.from("opportunities").select("*").eq("organization_id",organizationId).eq("contact_id",contactId);if(error)throw error;
 return (data??[]).some(o=>o.frozen_at && o.frozen_at>=messageCreatedAt);
}
