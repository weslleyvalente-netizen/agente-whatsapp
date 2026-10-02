import type {SupabaseClient} from "@supabase/supabase-js";
import {decideSalesPipeline,type Operation} from "@aula-agente/shared";
import {getOrganizationById} from "./organizations.js";
import {getQualificationByConversationId} from "./conversation-qualification.js";
import {getMessageById} from "./messages.js";
const FIELDS=["product_model","sale_amount","credit_amount","down_payment_amount","bid_amount","target_installment_amount","term_months","usage_purpose","urgency","commercial_notes","next_action"];
/** Best-effort at call sites. Never called from sandboxed Playground tools. */
export async function syncSalesPipeline(db:SupabaseClient,organizationId:string,conversationId:string,responseMessageId?:string):Promise<string|null>{
 const org=await getOrganizationById(db,organizationId);
 if(org.settings.sales_auto_pipeline_enabled!==true)return null;
 const {data:c,error}=await db.from("conversations").select("contact_id").eq("id",conversationId).eq("organization_id",organizationId).single();if(error)throw error;
 const [messageResult,qualification,opps,handoff]=await Promise.all([db.from("messages").select("*").eq("organization_id",organizationId).eq("conversation_id",conversationId).eq("role","contact").order("created_at",{ascending:false}).limit(30),getQualificationByConversationId(db,conversationId),db.from("opportunities").select("*").eq("organization_id",organizationId).eq("contact_id",c.contact_id).eq("status","open"),db.from("handoff_events").select("id").eq("organization_id",organizationId).eq("conversation_id",conversationId).eq("trigger_type","request_human").is("first_human_reply_at",null).order("handed_at",{ascending:false}).limit(1).maybeSingle()]);
 if(handoff.error)throw handoff.error;
 if(opps.error)throw opps.error;
 if(messageResult.error)throw messageResult.error; const customerMessages=messageResult.data??[]; const message=customerMessages[0];
 if(!message||message.organization_id!==organizationId||(opps.data??[]).length>1)return null;
 const response=responseMessageId?await getMessageById(db,responseMessageId):null;
 const confirmed=response?.role==="agent"&&response.evolution_message_id&&response.conversation_id===conversationId&&response.organization_id===organizationId;
 const decision=decideSalesPipeline({customerText:message.content,customerHistory:customerMessages.slice(1).reverse().map((m)=>m.content),qualification:qualification as unknown as Record<string,unknown>|null,operation:opps.data?.[0]?.operation as Operation|undefined,agentText:confirmed?response.content:undefined,humanHandoff:!!handoff.data && org.settings.sales_qualified_handoff_task_enabled===true});
 if(!decision)return null;
 const fields=Object.fromEntries(FIELDS.map(key=>[key,(qualification as unknown as Record<string,unknown>|null)?.[key]??null]));
 const result=await db.rpc("sync_sales_pipeline",{p_organization_id:organizationId,p_conversation_id:conversationId,p_customer_message_id:message.id,p_response_message_id:confirmed?responseMessageId:null,p_operation:decision.operation,p_stage:decision.stage,p_explicit_operation:decision.explicitOperation,p_fields:fields});
 if(result.error)throw result.error;return result.data as string|null;
}

export async function getUnidentifiedSalesContacts(db:SupabaseClient,organizationId:string){
 const rows:any[]=[]; const contactsWithBusiness=new Set<string>();
 for(let offset=0;;offset+=500){const {data,error}=await db.from("opportunities").select("contact_id").eq("organization_id",organizationId).order("id").range(offset,offset+499);if(error)throw error;for(const row of data??[])contactsWithBusiness.add(row.contact_id);if((data??[]).length<500)break;}
 const seen=new Set<string>();
 for(let offset=0;;offset+=500){const {data,error}=await db.from("conversations").select("id,contact_id,last_message_at,wa_contacts(name,phone)").eq("organization_id",organizationId).in("status",["open","waiting"]).order("last_message_at",{ascending:false}).order("id").range(offset,offset+499);if(error)throw error;
 for(const row of data??[])if(!contactsWithBusiness.has(row.contact_id)&&!seen.has(row.contact_id)){seen.add(row.contact_id);rows.push(row)}
 if((data??[]).length<500)break;}
 return rows;
}
