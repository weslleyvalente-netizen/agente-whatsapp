import { getInstanceById, updateMessageContent, type getAdminClient } from "@aula-agente/database";
import { transcribeAudioMessage } from "@aula-agente/agent-runtime";
import type {Conversation,Message} from "@aula-agente/shared";
export async function prepareFollowupAudioContext(db:ReturnType<typeof getAdminClient>,c:Conversation,messages:Message[]):Promise<{messages:Message[];changed:boolean}> {
 const missing=messages.filter(m=>["human_agent","contact"].includes(m.role) && m.media_type==="audio" && m.content.trim()==="[audio]");
 if(!missing.length) return {messages,changed:false};
 // Bound one request's paid work; older/unrecoverable media is an explicit
 // context gap, never an invitation to invent what the attendant said.
 if(missing.length>3 || missing.some(m=> !m.evolution_message_id || (m.metadata?.duration_seconds ?? 0)>300)) throw new Error("Há áudio sem transcrição no atendimento. Confira a conversa e escreva a mensagem manualmente.");
 const instance=await getInstanceById(db,c.evolution_instance_id);
 if(instance.organization_id!==c.organization_id) throw new Error("Instância não pertence à organização.");
 const prepared=messages.map(m=>({...m}));
 for(const audio of missing) {
  const transcription=await transcribeAudioMessage({instanceName:instance.instance_name,evolutionMessageId:audio.evolution_message_id!,organizationId:c.organization_id});
  if(!transcription.ok) throw new Error("Não foi possível transcrever um áudio deste atendimento. Confira o áudio no WhatsApp e escreva a mensagem manualmente; a sugestão foi bloqueada para não ignorar o que foi dito.");
  const content=`🎤 ${transcription.text}`;
  const metadata = {...audio.metadata, audio_transcribed_at: new Date().toISOString()};
  await updateMessageContent(db,audio.id,content,metadata);
  const updated = prepared.find(m=>m.id===audio.id)!;
  updated.content=content; updated.metadata=metadata;
 }
 return {messages:prepared,changed:true};
}
