import type { BankResult } from './policy.js';

// Official textual docs checked in the signed-in partner portal, 20/10/2026:
// https://www.ecredpro.com/desenvolvedores/docs/comecando#sandbox
// https://www.ecredpro.com/desenvolvedores/docs/simulacoes
// This is an isolated synthetic-data harness, NOT the live CRM adapter.
const BASE='https://cred-pro.com/v1';
const PROVIDER_STATUSES=['aprovado','recusado','simulacao','credencial_invalida','credencial_restricao','erro','manutencao','indisponivel'];
export type SandboxScenario='approved'|'rejected'|'mixed';
export type SandboxBank='PAN'|'C6'; // Only the two banks in the official sandbox example.
export class CredProSandboxError extends Error {
  constructor(readonly code:string){super(`CredPro sandbox: ${code}`);this.name='CredProSandboxError';}
}
const fail=(code:string):never=>{throw new CredProSandboxError(code);};
const record=(v:unknown):Record<string,unknown>=>{
  if(!v || typeof v!=='object' || Array.isArray(v))return fail('invalid_response');
  return v as Record<string,unknown>;
};
const idOf=(v:unknown):number=>typeof v==='number' && Number.isSafeInteger(v) && v>0?v:fail('invalid_consultation_id');
function sandbox(data:unknown){const obj=record(data);if(obj.sandbox!==true)fail('sandbox_unconfirmed');return obj;}
function reais(value:unknown):number|null{
  if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:null;
  if(typeof value!=='string' || !/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{2})?$/.test(value.trim()))return null;
  const n=Number(value.trim().replace(/\./g,'').replace(',','.'));return Number.isFinite(n)?n:null;
}
function offers(data:unknown):BankResult['offers']{
  if(!data || typeof data!=='object')return [];
  const row=record(data),entry=reais(row.valor_entrada);
  const match=typeof row.parcelas==='string'?row.parcelas.trim().match(/^(\d{1,3})\s*x\s+de\s+R\$\s*([\d.,]+)$/i):null;
  const amount=match?reais(match[2]):null;
  if(entry===null || !match || amount===null || amount<=0 || Number(match[1])<=0)return [];
  return [{downPayment:entry,installments:Number(match[1]),installmentAmount:amount}];
}
export interface SandboxResult {
  consultationId:number;state:'processing'|'completed';sandbox:true;
  results:Array<{bank:string;status:BankResult['status']|'pending';providerStatus:string|null;offers:BankResult['offers']}>;
}
export function normalizeSandboxResult(data:unknown):SandboxResult{
  const obj=sandbox(data),id=idOf(obj.consulta_id);
  if(!['processando','concluida'].includes(String(obj.status)))fail('invalid_response');
  const rows=obj.resultados??[];
  if(!Array.isArray(rows) || (obj.status==='concluida'&&!rows.length))fail('invalid_response');
  const seen=new Set<string>();
  const results=(rows as unknown[]).map(value=>{
    const row=record(value);
    if(typeof row.banco!=='string' || !row.banco || row.banco.length>80 || seen.has(row.banco))return fail('invalid_bank_result');
    seen.add(row.banco);
    const status=row.status;
    if(status!==null && (typeof status!=='string'||!PROVIDER_STATUSES.includes(status)))return fail('invalid_bank_status');
    const normalized:BankResult['status']|'pending'=status===null?'pending':status==='aprovado'?'preapproved':status==='recusado'?'rejected':status==='simulacao'?'simulation':'error';
    return {bank:row.banco,status:normalized,providerStatus:status as string|null,offers:status==='aprovado'||status==='simulacao'?offers(row.dados):[]};
  });
  return {consultationId:id,state:obj.status==='concluida'?'completed':'processing',sandbox:true,results};
}
export class CredProSandboxClient {
  readonly #key:string;
  readonly #fetcher:typeof fetch;
  readonly #consultations=new Map<number,Set<string>>();
  #tail:Promise<unknown>=Promise.resolve();
  #lastRequest=0;
  constructor({key,fetcher=fetch}:{key:string;fetcher?:typeof fetch}){
    if(!/^cpk_test_[A-Za-z0-9_-]{8,}$/.test(key))fail('test_key_required');
    this.#key=key;this.#fetcher=fetcher;
  }
  async #request(path:string,body?:unknown):Promise<Record<string,unknown>>{
    const result=this.#tail.then(async()=>{
      // One active request, >=3.1s between starts, <=20/min for this harness.
      // Do not deploy multiple instances as an account-wide rate limiter.
      const wait=Math.max(0,3100-(Date.now()-this.#lastRequest));
      if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
      this.#lastRequest=Date.now();
      let response:Response;
      try{response=await this.#fetcher(`${BASE}${path}`,{
        method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${this.#key}`,'Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(10_000),
      });}catch{return fail(body===undefined?'transport_failed':'creation_unknown');}
      // No raw bodies/headers in errors, no POST retries, including on timeout.
      if(!response.ok)return fail(`http_${response.status}`);
      let data:unknown;try{data=await response.json();}catch{return fail('invalid_response');}
      return sandbox(data);
    });
    this.#tail=result.then(()=>undefined,()=>undefined);return result;
  }
  async start(scenario:SandboxScenario,banks:SandboxBank[]):Promise<number>{
    if(!['approved','rejected','mixed'].includes(scenario) || !Array.isArray(banks) || !banks.length || banks.length>2 ||
      banks.some(b=>!['PAN','C6'].includes(b)) || new Set(banks).size!==banks.length)fail('invalid_fixture');
    const body={
      cpf:scenario==='approved'?'11111111119':scenario==='rejected'?'11111111110':'11111111111',
      celular:'11999990000',placa:'ABC1D23',data_nascimento:'1985-03-15',tipo_veiculo:'moto',possui_cnh:true,
      bancos:Object.fromEntries(banks.map(bank=>[bank,{usuario:'x',senha:'x'}])),
    };
    const data=await this.#request('/simulacoes',body),id=idOf(data.consulta_id);
    if(data.status!=='processando' && data.status!=='concluida')fail('invalid_response');
    this.#consultations.set(id,new Set(banks));return id;
  }
  async result(id:number):Promise<SandboxResult>{
    if(!this.#consultations.has(id))return fail('unknown_consultation');
    const result=normalizeSandboxResult(await this.#request(`/simulacoes/${idOf(id)}`));
    if(result.consultationId!==id || result.results.some(row=>!this.#consultations.get(id)!.has(row.bank)))fail('invalid_response');
    if(result.state==='completed' && (result.results.length!==this.#consultations.get(id)!.size || result.results.some(r=>r.status==='pending')))fail('incomplete_result');
    return result;
  }
}
