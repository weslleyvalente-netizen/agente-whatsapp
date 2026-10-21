import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {createClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {manualLiveSchema,manualSandboxSchema,manualSettingsSchema} from '@aula-agente/shared';
import {getAdminClient,encryptCpf,decryptCpf,hashCpf,CredProManualClient,CredProManualError} from '@aula-agente/database';
import {authMiddleware} from '../../middleware/auth.js';
import {isManager} from '../../lib/lead-visibility.js';
import {providerPayload,publicCase,sandboxApplication} from './payload.js';
const uuid=z.string().uuid();
type Params={organizationId:string;caseId:string};
const prefix='/organizations/:organizationId/manual-financing';
const seal=(v:unknown)=>encryptCpf(JSON.stringify(v));
const open=(v:string)=>JSON.parse(decryptCpf(v));

export default async function manualFinancingRoutes(app:FastifyInstance){
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','no-store');});
 app.addHook('preHandler',authMiddleware);
 app.addHook('preHandler',async(req,reply)=>{
  const org=(req.params as Params).organizationId;
  if(!uuid.safeParse(org).success||!req.user.memberships.some(m=>m.organization_id===org))return reply.code(403).send({error:'Acesso restrito.'});
 });
 // Never log thrown provider/crypto/database errors or request bodies from this plugin.
 app.setErrorHandler((_error,_req,reply)=>reply.code(503).send({error:'Consulta indisponível. Confira o histórico antes de tentar novamente.'}));
 const manager=(req:FastifyRequest)=>req.user.memberships.some(m=>m.organization_id===(req.params as Params).organizationId&&isManager(m.role));
 const db=()=>getAdminClient();
 async function setting(org:string){const r=await db().from('manual_financing_settings').select('*').eq('organization_id',org).maybeSingle();if(r.error)throw Error('settings');return r.data;}
 async function owned(req:FastifyRequest){
  const p=req.params as Params;if(!uuid.safeParse(p.caseId).success)return null;
  let q=db().from('manual_financing_cases').select('*').eq('id',p.caseId).eq('organization_id',p.organizationId);
  if(!manager(req))q=q.eq('seller_id',req.user.id);
  const r=await q.maybeSingle();if(r.error)throw Error('case');return r.data;
 }
 async function inventory(org:string){
  const catalogKey=process.env.CATALOG_SUPABASE_ANON_KEY||process.env.CATALOG_SUPABASE_SERVICE_ROLE_KEY;
  if(process.env.CATALOG_ORGANIZATION_ID!==org||!process.env.CATALOG_SUPABASE_URL||!catalogKey)return [];
  const c=createClient(process.env.CATALOG_SUPABASE_URL,catalogKey,{auth:{persistSession:false}});
  const r=await c.from('vehicles').select('id,marca,modelo,ano,preco,tipo').eq('status','available').order('modelo').limit(500);
  if(r.error)throw Error('inventory');return r.data??[];
 }
 app.get<{Params:Params}>(prefix,async(req)=>{
  const s=await setting(req.params.organizationId);
  let vehicles:unknown[]=[];try{vehicles=await inventory(req.params.organizationId);}catch{/* External vehicles remain available. */}
  return {canManage:manager(req),settings:s?{mode:s.mode,enabled:s.enabled,banks:s.banks}:null,vehicles};
 });
 app.put<{Params:Params}>(prefix+'/settings',async(req,reply)=>{
  if(!manager(req))return reply.code(403).send({error:'Somente gestores podem configurar.'});
  const parsed=manualSettingsSchema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'Confira ambiente, chave completa e acessos dos bancos.'});
  const v=parsed.data,banks=v.mode==='sandbox'?['PAN','C6']:v.banks.map(b=>b.bank);
  const r=await db().from('manual_financing_settings').upsert({organization_id:req.params.organizationId,revision:randomUUID(),mode:v.mode,enabled:v.enabled,banks,credentials_encrypted:seal(v),account_hash:hashCpf(v.key),updated_by:req.user.id,updated_at:new Date().toISOString()});
  if(r.error)throw Error('save');return {saved:true};
 });
 app.post<{Params:Params}>(prefix+'/settings/test',async(req,reply)=>{
  if(!manager(req))return reply.code(403).send({error:'Somente gestores podem configurar.'});
  const s=await setting(req.params.organizationId);if(!s)return reply.code(409).send({error:'Salve a configuração primeiro.'});
  const gate=await db().rpc('manual_financing_gate',{p_org:req.params.organizationId,p_case:null,p_account:s.account_hash,p_action:'test'});
  if(gate.error)throw Error('gate');if(!gate.data)return reply.code(429).send({error:'Aguarde alguns segundos antes de testar.'});
  const credentials=open(s.credentials_encrypted),client=new CredProManualClient(s.mode,credentials.key);
  try{return {connected:true,banks:(await client.banks()).filter(b=>s.banks.includes(b.bank))};}catch{return reply.code(503).send({error:'Conexão não confirmada. Confira a chave e a disponibilidade da CredPro.'});}
 });
 app.get<{Params:Params}>(prefix+'/cases',async(req)=>{
  let q=db().from('manual_financing_cases').select('*').eq('organization_id',req.params.organizationId).order('created_at',{ascending:false}).limit(50);
  if(!manager(req))q=q.eq('seller_id',req.user.id);
  const r=await q;if(r.error)throw Error('history');return {cases:(r.data??[]).map(row=>publicCase(row,open(row.application_encrypted)))};
 });
 app.post<{Params:Params}>(prefix+'/cases',async(req,reply)=>{
  const key=uuid.safeParse(req.headers['idempotency-key']);if(!key.success)return reply.code(400).send({error:'Referência da ficha inválida.'});
  const s=await setting(req.params.organizationId);if(!s?.enabled)return reply.code(409).send({notPrepared:true,error:'Consultas desativadas. Solicite a configuração ao gestor.'});
  const parsed=(s.mode==='sandbox'?manualSandboxSchema:manualLiveSchema).safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'Confira os dados obrigatórios da ficha e a autorização.'});
  const input=parsed.data;
  if(!input.banks.every(b=>s.banks.includes(b)))return reply.code(400).send({error:'Selecione somente bancos configurados.'});
  // Fingerprint the original validated intent; stock snapshots need not be identical on a retry.
  const fingerprint=hashCpf(JSON.stringify({input,actor:req.user.id}));
  const existing=await db().from('manual_financing_cases').select('*').eq('organization_id',req.params.organizationId).eq('idempotency_key',key.data).maybeSingle();
  if(existing.error)throw Error('lookup');
  if(existing.data){if(existing.data.seller_id!==req.user.id||existing.data.fingerprint!==fingerprint)return reply.code(409).send({error:'Referência já utilizada. Confira o histórico.'});return publicCase(existing.data,open(existing.data.application_encrypted));}
  let application;
  if('scenario' in input)application=sandboxApplication(input.scenario,input.banks);
  else{
   if(Date.parse(input.consent.expiresAt)<=Date.now())return reply.code(400).send({error:'A autorização deve ter validade futura.'});
   const vehicle=input.vehicle.source==='external'?input.vehicle:(await inventory(req.params.organizationId)).find(v=>v.id===('vehicleId' in input.vehicle?input.vehicle.vehicleId:0));
   if(!vehicle)return reply.code(409).send({notPrepared:true,error:'Veículo indisponível. Atualize o estoque ou informe um veículo avulso.'});
   application={...input,vehicle:{...vehicle,source:input.vehicle.source}};
  }
  const expires='scenario' in input?new Date(Date.now()+86400000).toISOString():input.consent.expiresAt;
  const r=await db().from('manual_financing_cases').insert({organization_id:req.params.organizationId,seller_id:req.user.id,idempotency_key:key.data,fingerprint,config_revision:s.revision,account_hash:s.account_hash,mode:s.mode,banks:input.banks,application_encrypted:seal(application),credentials_encrypted:s.credentials_encrypted,consent_expires_at:expires}).select('*').single();
  // A simultaneous duplicate is recovered through history; never creates a provider request here.
  if(r.error)return reply.code(409).send({error:'Ficha não confirmada. Confira o histórico antes de preparar outra.'});
  return reply.code(201).send(publicCase(r.data,application));
 });
 app.post<{Params:Params}>(prefix+'/cases/:caseId/start',async(req,reply)=>{
  const row=await owned(req);if(!row)return reply.code(404).send({error:'Consulta não encontrada.'});
  if(row.state!=='prepared')return publicCase(row,open(row.application_encrypted));
  const application=open(row.application_encrypted),credentials=open(row.credentials_encrypted);
  const client=new CredProManualClient(row.mode,credentials.key),payload=providerPayload(application,credentials,row.mode);
  const g=await db().rpc('manual_financing_gate',{p_org:row.organization_id,p_case:row.id,p_account:row.account_hash,p_action:'start'});
  if(g.error)throw Error('gate');if(!g.data)return reply.code(409).send({error:'Envio não iniciado: aguarde alguns segundos, confira a autorização e a configuração. Há limite de três consultas em andamento.'});
  try{
   const provider=await client.start(payload);
   const r=await db().rpc('manual_financing_register',{p_org:row.organization_id,p_case:row.id,p_provider:provider});
   if(r.error||!r.data)throw Error('persist');
  }catch(error){
   if(error instanceof CredProManualError&&/^not_created_(401|402|422|429)$/.test(error.code)){
    await db().rpc('manual_financing_rejected',{p_org:row.organization_id,p_case:row.id,p_code:error.code});
   }else await db().from('manual_financing_cases').update({state:'creation_unknown',error_code:'creation_unknown'}).eq('id',row.id).eq('organization_id',row.organization_id).eq('state','submitting');
  }
  const current=await owned(req);if(!current)throw Error('case');return publicCase(current,application);
 });
 app.post<{Params:Params}>(prefix+'/cases/:caseId/refresh',async(req,reply)=>{
  const row=await owned(req);if(!row)return reply.code(404).send({error:'Consulta não encontrada.'});
  if(row.state==='submitting'&&Date.parse(row.submitted_at)<Date.now()-20000){await db().from('manual_financing_cases').update({state:'creation_unknown',error_code:'creation_unknown'}).eq('id',row.id).eq('state','submitting');row.state='creation_unknown';}
  if(['processing','cancelled'].includes(row.state)&&row.provider_id&&!row.provider_finished_at){
   const g=await db().rpc('manual_financing_gate',{p_org:row.organization_id,p_case:row.id,p_account:row.account_hash,p_action:'poll'});
   if(g.error)throw Error('gate');
   if(g.data){try{
    const c=open(row.credentials_encrypted),result=await new CredProManualClient(row.mode,c.key).result(Number(row.provider_id),row.banks);
    const r=await db().rpc('manual_financing_finish',{p_org:row.organization_id,p_case:row.id,p_provider:row.provider_id,p_results:result.results,p_completed:result.state==='completed'});if(r.error)throw Error('persist');
   }catch{return reply.code(503).send({error:'Resultado indisponível. Atualizar novamente apenas busca a consulta existente; não cria outra.'});}}
  }
  const current=await owned(req);if(!current)throw Error('case');return publicCase(current,open(current.application_encrypted));
 });
 app.post<{Params:Params}>(prefix+'/cases/:caseId/cancel',async(req,reply)=>{
  const row=await owned(req);if(!row)return reply.code(404).send({error:'Consulta não encontrada.'});
  const r=await db().rpc('manual_financing_cancel',{p_org:row.organization_id,p_case:row.id});if(r.error)throw Error('cancel');return {cancelled:true};
 });
}
