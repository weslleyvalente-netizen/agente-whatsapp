import type {BankResult} from './policy.js';
export type CredProMode='sandbox'|'live';
export class CredProManualError extends Error{constructor(readonly code:string){super(code);this.name='CredProManualError';}}
const fail=(code:string):never=>{throw new CredProManualError(code);};
const obj=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail('invalid_response');
const id=(value:unknown):number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:fail('invalid_consultation_id');
function modeOf(row:Record<string,unknown>,mode:CredProMode){if(mode==='sandbox'&&row.sandbox!==true)fail('sandbox_unconfirmed');if(mode==='live'&&row.sandbox!==undefined&&row.sandbox!==false)fail('wrong_environment');}
function reais(value:unknown):number|null{
 if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:null;
 if(typeof value!=='string'||!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{2})?$/.test(value.trim()))return null;
 const n=Number(value.trim().replace(/\./g,'').replace(',','.'));return Number.isFinite(n)?n:null;
}
function offers(value:unknown):BankResult['offers']{
 if(!value||typeof value!=='object')return [];const row=obj(value),entry=reais(row.valor_entrada);
 const match=typeof row.parcelas==='string'?row.parcelas.trim().match(/^(\d{1,3})\s*x\s+de\s+R\$\s*([\d.,]+)$/i):null;
 const amount=match?reais(match[2]):null;
 return entry!==null&&match&&Number(match[1])>0&&amount!==null&&amount>0?[{downPayment:entry,installments:Number(match[1]),installmentAmount:amount}]:[];
}
export type CredProManualResult={consultationId:number;state:'processing'|'completed';results:Array<{bank:string;status:BankResult['status']|'pending';providerStatus:string|null;offers:BankResult['offers']}>};
export function normalizeCredProManualResult(data:unknown,mode:CredProMode,expectedBanks:string[]):CredProManualResult{
 const row=obj(data);modeOf(row,mode);const consultationId=id(row.consulta_id);
 if(!['processando','concluida'].includes(String(row.status))||!Array.isArray(row.resultados))return fail('invalid_response');
 const seen=new Set<string>(),allowed=['aprovado','recusado','simulacao','credencial_invalida','credencial_restricao','erro','manutencao','indisponivel'];
 const results=row.resultados.map(value=>{
  const bank=obj(value);if(typeof bank.banco!=='string'||!expectedBanks.includes(bank.banco)||seen.has(bank.banco))return fail('invalid_bank_result');seen.add(bank.banco);
  const status=bank.status;if(status!==null&&(typeof status!=='string'||!allowed.includes(status)))return fail('invalid_bank_status');
  const normalized:BankResult['status']|'pending'=status===null?'pending':status==='aprovado'?'preapproved':status==='recusado'?'rejected':status==='simulacao'?'simulation':'error';
  return {bank:bank.banco,status:normalized,providerStatus:status as string|null,offers:status==='aprovado'||status==='simulacao'?offers(bank.dados):[]};
 });
 if(row.status==='concluida'&&(results.length!==expectedBanks.length||results.some(r=>r.status==='pending')))fail('incomplete_result');
 return {consultationId,state:row.status==='concluida'?'completed':'processing',results};
}
/** Callers MUST use the durable shared gate before each call. No automatic POST retry. */
export class CredProManualClient{
 readonly #key:string;readonly #mode:CredProMode;readonly #fetcher:typeof fetch;
 constructor(mode:CredProMode,key:string,fetcher:typeof fetch=fetch){
  if(!new RegExp(`^cpk_${mode==='sandbox'?'test':'live'}_[A-Za-z0-9_-]{8,}$`).test(key))fail('key_mode_mismatch');this.#key=key;this.#mode=mode;this.#fetcher=fetcher;
 }
 async #request(path:string,body?:Record<string,unknown>){
  let response:Response;
  try{response=await this.#fetcher(`https://cred-pro.com/v1${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${this.#key}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(10_000)});}catch{return fail(body?'creation_unknown':'transport_failed');}
  if(!response.ok){
   // Only documented rejection codes prove that creation did not occur.
   const rejected:Record<number,string[]>={401:['chave_invalida'],402:['saldo_insuficiente'],422:['banco_nao_suportado','dados_invalidos','placa_invalida','veiculo_obrigatorio'],429:['limite_concorrencia','limite_taxa']};
   let code:unknown;try{const error=await response.json() as {detail?:{erro?:{codigo?:unknown}}};code=error?.detail?.erro?.codigo;}catch{/* Unknown HTTP failure remains ambiguous. */}
   if(body&&typeof code==='string'&&rejected[response.status]?.includes(code))fail(`not_created_${response.status}`);
   fail(`http_${response.status}`);
  }
  let raw:unknown;try{raw=await response.json();}catch{return fail(body?'creation_unknown':'invalid_response');}
  const data=obj(raw);
  // Verified provider behavior: the read-only bank directory has no sandbox marker.
  // Credit creation/results still require it; explicit wrong markers always fail.
  if(path!=='/bancos'||data.sandbox!==undefined)modeOf(data,this.#mode);return data;
 }
 async start(body:Record<string,unknown>){const data=await this.#request('/simulacoes',body);if(!['processando','concluida'].includes(String(data.status)))fail('creation_unknown');return id(data.consulta_id);}
 async result(consultationId:number,banks:string[]){const value=id(consultationId),result=normalizeCredProManualResult(await this.#request(`/simulacoes/${value}`),this.#mode,banks);if(result.consultationId!==value)fail('wrong_consultation');return result;}
 async banks(){const data=await this.#request('/bancos');if(!Array.isArray(data.bancos))return fail('invalid_response');return data.bancos.map((v:unknown)=>{const row=obj(v);if(typeof row.banco!=='string'||typeof row.disponivel_agora!=='boolean')return fail('invalid_response');return {bank:row.banco,available:row.disponivel_agora};});}
}
