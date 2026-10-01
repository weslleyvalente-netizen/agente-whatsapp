import type {Operation} from "./types/opportunity.js";
export interface PipelineInput {customerText:string;qualification:Record<string,unknown>|null;operation?:Operation;agentText?:string;}
const normalize=(s:string)=>s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
export function decideSalesPipeline(input:PipelineInput):{operation:Operation;stage:string;explicitOperation:boolean}|null{
 const customer=normalize(input.customerText);const q=input.qualification??{};
 if(/nao (?:tenho|quero)(?: mais)? interesse|\bdesisti\b|ja comprei/.test(customer))return null;
 const positive=customer.replace(/\b(?:nao|nem)\s+(?:(?:quero|e|tenho interesse(?: em)?|gostaria de|preciso de)\s+)?(?:o |um |de |mais )?(?:financiamento|financiar|consorcio|libera\s*cred|carta contemplada|bike|bicicleta|a vista)\b/g," ");
 const signals:[Operation,boolean][]=[
  ["consortium",/\bconsorcio\b/.test(positive)],
  ["financing",/\bfinanciamento\b|\bfinanciar\b/.test(positive)],
  ["libera_cred",/libera\s*cred/.test(positive)],
  ["contemplated_letter",/carta contemplada/.test(positive)],
  ["vehicle_sale",/\ba vista\b|\bbike\b|\bbicicleta\b/.test(positive)],
 ];
 const explicit=signals.filter(([,hit])=>hit).map(([op])=>op);
 if(explicit.length>1 || !explicit.length && positive!==customer) return null;
 const attendance:Partial<Record<string,Operation>>={consortium:"consortium",financing:"financing",cash:"vehicle_sale"};
 const operation=explicit[0]??input.operation??attendance[String(q.attendance_type)];
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
 return {operation,stage,explicitOperation:explicit.length===1};
}
