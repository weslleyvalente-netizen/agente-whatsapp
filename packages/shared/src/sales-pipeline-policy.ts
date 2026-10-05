import type {Operation} from "./types/opportunity.js";
export interface PipelineInput {customerText:string;customerHistory?:string[];qualification:Record<string,unknown>|null;operation?:Operation;agentText?:string;humanHandoff?:boolean;humanHandoffMotive?:string|null;}
/** Click-to-WhatsApp ads prepend this marker; the text after it is pre-filled by the ad, not typed interest. */
export const isAdClickMessage=(text:string|null|undefined)=>(text??"").startsWith("[Cliente veio de um anúncio:");
const normalize=(s:string)=>s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
export function decideSalesPipeline(rawInput:PipelineInput):{operation:Operation;stage:string;explicitOperation:boolean}|null{
 // An ad click alone is a hint, never evidence of interest: wait for a real customer message.
 if(isAdClickMessage(rawInput.customerText))return null;
 const input={...rawInput,customerHistory:(rawInput.customerHistory??[]).filter(t=>!isAdClickMessage(t))};
 // Repair only short repeated-letter noise after an explicit interest phrase.
 // Do not turn arbitrary words beginning with consorcio into product intent.
 const customer=normalize(input.customerText).replace(/\b(tenho interesse em|quero|gostaria de)\s+consorcio([a-z]{1,6})\b/g,(text,prefix:string,suffix:string)=>/([a-z])\1/.test(suffix)?`${prefix} consorcio`:text);const q=input.qualification??{};
 if(/nao (?:tenho|quero)(?: mais)? interesse|\bdesisti\b|ja comprei/.test(customer))return null;
 const positive=customer.replace(/\b(?:nao|nem)\s+(?:(?:quero|e|tenho interesse(?: em)?|gostaria de|preciso de)\s+)?(?:o |um |de |mais )?(?:financiamento|financiar|consorcio|libera\s*cred|carta contemplada|bike|bicicleta|a vista)\b/g," ");
 const signals:[Operation,boolean][]=[
  ["consortium",/\bconsorcio\b/.test(positive)],
  ["financing",/\bfinanciamento\b|\bfinanciar\b/.test(positive)],
  ["libera_cred",/libera\s*cred/.test(positive)],
  ["contemplated_letter",/carta contemplada/.test(positive)],
  ["vehicle_sale",/\ba vista\b|\bbike\b|\bbicicleta\b|\bmoto(?:cicleta)?\s+eletrica\b/.test(positive)],
 ];
 const explicit=signals.filter(([,hit])=>hit).map(([op])=>op);
 if(explicit.length>1 || !explicit.length && positive!==customer) return null;
 const attendance:Partial<Record<string,Operation>>={consortium:"consortium",financing:"financing",cash:"vehicle_sale"};
 let historicalOperation:Operation|undefined;
 // Read customer evidence newest first; never infer intent from the AI's offers.
 if(!explicit.length && !input.operation && !attendance[String(q.attendance_type)]) {
  for(const text of [...(input.customerHistory??[])].reverse()) {
   const normalized=normalize(text);
   if(/nao (?:tenho|quero)(?: mais)? interesse|\bdesisti\b|ja comprei|\bnao\s+(?:quero|tenho interesse)/.test(normalized))return null;
   const historical=decideSalesPipeline({customerText:text,qualification:null});
   if(historical){historicalOperation=historical.operation;break;}
   if(/consorcio|financiamento|financiar|libera\s*cred|carta contemplada|\bbike\b|\bbicicleta\b|moto\s+eletrica/.test(normalized))return null;
  }
 }
 const operation=explicit[0]??input.operation??attendance[String(q.attendance_type)]??historicalOperation;
 if(!operation)return null;
 let stage="interest_received";
 const interested=!!(q.product_model||q.product_interest);
 const relevant=!!(q.usage_purpose||q.urgency||q.city) || [q.sale_amount,q.credit_amount,q.down_payment_amount,q.bid_amount,q.target_installment_amount].some(x=>typeof x==="number"&&x>=0);
 if(interested&&relevant)stage="qualification";
 // Only a persisted, confirmed outbound text may establish presentation.
 const outbound=normalize(input.agentText??"").split(/(?<=[.!?])\s+/).filter(sentence=>!sentence.includes("?") && !/\b(?:vou|vamos|preciso|precisamos)\s+(?:verificar|consultar|simular|confirmar)|\bestimativ|\bestimad|\baproximad|\btalvez/.test(sentence)).join(" ");
 const amounts=[q.sale_amount,q.credit_amount,q.target_installment_amount].filter((x):x is number=>typeof x==="number"&&x>0);
 const denied=/\bnao\s+(?:temos|tenho|existe|oferecemos|podemos|conseguimos)|indisponivel/.test(outbound);
 const presented=!denied && amounts.some(n=>outbound.includes(`r$ ${n.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`));
 const term=typeof q.term_months==="number"&&new RegExp(`\\b${q.term_months}\\s*(?:x|vezes|parcelas|meses)\\b`).test(outbound);
 if(presented&&(operation!=="libera_cred"&&operation!=="consortium"||term)){
  if(operation==="libera_cred")stage="plan_term_presented";
  else if(operation==="consortium")stage="simulation_sent";
  else if(operation==="vehicle_sale"||operation==="contemplated_letter")stage="proposal_sent";
 }
 if(/\b(?:quero|vou|vamos|gostaria de)\s+(?:fechar|aderir|avancar)|\bnegociar\b/.test(customer)){
  const decision:Partial<Record<Operation,string>>={consortium:"decision_negotiation",libera_cred:"decision_objections",vehicle_sale:"negotiation"};
  stage=decision[operation]??stage;
 }
 if(input.humanHandoff && ['negociacao_valor','proposta_pronta','cliente_pediu'].includes(input.humanHandoffMotive??'')){
  const handoffStages:Partial<Record<Operation,string>>={vehicle_sale:'negotiation',consortium:'decision_negotiation',libera_cred:'decision_objections'};
  stage=handoffStages[operation]??stage;
  // A request for human help does not prove that a letter proposal was sent.
  if(operation==='contemplated_letter' && stage!=='proposal_sent')stage='compatible_letter_search';
 }
 if(operation==='financing' && input.humanHandoff && interested){
  const complete=!!q.cpf_encrypted && !!q.birth_date && typeof q.has_driver_license==='boolean' && typeof q.down_payment_amount==='number' && q.down_payment_amount>=0;
  stage=complete?'awaiting_simulation':'documentation';
 }
 return {operation,stage,explicitOperation:explicit.length===1};
}
