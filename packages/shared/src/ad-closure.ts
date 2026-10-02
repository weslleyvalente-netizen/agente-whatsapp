export const DEFAULT_AD_CLOSING_MESSAGE = 'Vou encerrar por aqui por enquanto 😊 Quando quiser retomar, é só me mandar uma mensagem. Seguimos à disposição para tirar suas dúvidas e ajudar você a escolher a melhor opção!';
export function validateClosingSettings(message?: unknown, delay?: unknown) {
 const text=message===undefined?DEFAULT_AD_CLOSING_MESSAGE:message;
 const hours=delay===undefined?1:Number(delay);
 if(typeof text!=='string' || !text.trim() || text.length>1000 || /\{[^}]*\}|\[(?:nome|cliente|telefone|modelo)\]/i.test(text) || !Number.isFinite(hours) || hours<0.25 || hours>168)throw new Error('Informe uma mensagem sem campos pendentes e um intervalo entre 0,25 e 168 horas.');
 return {message:text.trim(),delayHours:hours};
}
export interface AdClosureState {
 messages:Array<{id:string;role:string;content?:string;created_at:string;evolution_message_id?:string|null;metadata?:any}>;
 conversations:Array<{id:string;is_human_takeover:boolean;status:string;evolution_instance_id?:string;agent_id?:string}>;
 opportunities:any[];qualifications:any[];handoffs:any[];aiDisabled:boolean;ignored:boolean;
}
export function isUnengagedAdContact(state:AdClosureState, initialMessageId:string):boolean {
 if(state.aiDisabled || state.ignored || state.opportunities.length || state.handoffs.some(h=>h.trigger_type==='request_human') || state.conversations.some(c=>c.is_human_takeover || c.status==='closed'))return false;
 const contacts=state.messages.filter(m=>m.role==='contact');
 if(contacts.length!==1 || contacts[0].id!==initialMessageId || state.messages.some(m=>m.role==='human_agent'))return false;
 const content=contacts[0].content ?? '';
 if(!content.startsWith('[Cliente veio de um anúncio:'))return false;
 const tail=content.slice(content.lastIndexOf(']')+1).replace(/\\n/g,'\n').trim();
 if(!['Como funciona o consórcio da Yamaha Fazer FZ25?','Quais documentos eu preciso pra fazer o consórcio da Fazer 250?','Tenho interesse no plano LiberaCred (compra programada)','Moro nos EUA e quero saber como fazer meu consórcio!'].includes(tail))return false;
 const fields=['cpf_encrypted','birth_date','down_payment_amount','target_installment_amount','bid_amount','usage_purpose','urgency'];
 if(state.qualifications.some(q=>fields.some(f=>q[f]!=null && q[f]!=='') || q.human_locked_fields?.length))return false;
 return state.messages.some(m=>m.role==='agent' && new Date(m.created_at)>new Date(contacts[0].created_at));
}
export function canCloseAdTasks(tasks:any[], snapshots:Array<{id:string;updated_at:string}>):boolean {
 const open=tasks.filter(t=>['pending','in_progress','rescheduled'].includes(t.status));
 const safe=(type:string)=>['customer_unresponsive','return_customer'].includes(type);
 return open.length>0 && open.length===snapshots.length && open.every(t=>snapshots.some(s=>s.id===t.id && s.updated_at===t.updated_at) && t.created_by_type==='ai' && safe(t.type) && !t.followup_pending_message_id && (t.consolidated_pendencies??[]).every((p:any)=>safe(p.type) && !p.freeze_opportunity_id));
}
export function buildAdClosureSchedule<T extends {contactId:string;group:string}>(contacts:T[],start:string,end:string,intervalMinutes=15):Array<T&{scheduledAt:string}> {
 const from=Date.parse(start),until=Date.parse(end);
 if(!Number.isFinite(from) || !Number.isFinite(until) || until<=from || until-from>86400000 || !Number.isFinite(intervalMinutes) || intervalMinutes<15)throw new Error('Janela ou intervalo inválido.');
 const seen=new Set<string>(),groups=new Map<string,T[]>();
 for(const c of contacts){if(seen.has(c.contactId))continue;seen.add(c.contactId);const group=groups.get(c.group)??[];group.push(c);groups.set(c.group,group);}
 const ordered:T[]=[];
 while([...groups.values()].some(g=>g.length)){for(const g of groups.values()){const next=g.shift();if(next)ordered.push(next);}}
 if(ordered.length>40 || from+(ordered.length-1)*intervalMinutes*60000>=until)throw new Error('A fila não cabe na janela de atendimento.');
 return ordered.map((c,i)=>({...c,scheduledAt:new Date(from+i*intervalMinutes*60000).toISOString()}));
}

export interface ScheduledAdClosureRecipient {
 contactId:string;conversationId:string;initialMessageId:string;scheduledAt:string;group:string;
 tasks:Array<{id:string;updated_at:string}>;
}
export interface ScheduledAdClosureBatch {
 id:string;startAt:string;endAt:string;intervalMinutes:number;message:string;recipients:ScheduledAdClosureRecipient[];
}
