import Fastify from 'fastify';
import {describe,it,expect,vi,beforeEach} from 'vitest';
const org='00000000-0000-0000-0000-000000000001',id='00000000-0000-0000-0000-000000000002';
const state=vi.hoisted(()=>({role:'member',user:'seller',org:'00000000-0000-0000-0000-000000000001',row:null as any,settings:null as any,gate:true,post:vi.fn(),banks:vi.fn(),rpc:vi.fn(),queries:[] as any[],catalogSelect:vi.fn()}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({from:()=>({select:(columns:string)=>{state.catalogSelect(columns);return {eq:()=>({order:()=>({limit:async()=>({data:[{id:7,tipo:'moto',marca:'Honda',modelo:'CG 160',ano:2025,preco:21000}],error:null})})})};}})})}));
vi.mock('../../middleware/auth.js',()=>({authMiddleware:async(req:any)=>{req.user={id:state.user,memberships:[{organization_id:state.org,role:state.role}]};}}));
vi.mock('@aula-agente/database',()=>({
 encryptCpf:(s:string)=>'sealed:'+s,decryptCpf:(s:string)=>s.replace(/^sealed:/,''),hashCpf:()=> 'a'.repeat(64),
 CredProManualClient:class{start=state.post;banks=state.banks;},CredProManualError:class extends Error{constructor(readonly code:string){super(code);}},
 getAdminClient:()=>({rpc:async(name:string,args:any)=>{state.rpc(name,args);return {data:name==='manual_financing_gate'?state.gate:true,error:null};},from:(table:string)=>{
  const filters:Record<string,unknown>={};let mutation:any;
  const result=()=>{state.queries.push({table,filters,mutation});const row=table==='manual_financing_settings'?state.settings:mutation?.application_encrypted?{id,state:'prepared',...mutation}:state.row;return {data:row&&(!filters.seller_id||filters.seller_id===row.seller_id)?row:null,error:null};};
  const q:any={select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},maybeSingle:async()=>result(),single:async()=>result(),insert:(v:any)=>{mutation=v;return q;},update:(v:any)=>{mutation=v;return q;},upsert:(v:any)=>{mutation=v;return q;},then:(resolve:any)=>Promise.resolve(result()).then(resolve)};return q;
 }})
}));
import routes from './index.js';
import {CredProManualError} from '@aula-agente/database';
describe('manual financing authorization and dispatch',()=>{
 beforeEach(()=>{state.role='member';state.user='seller';state.org=org;state.row={id,organization_id:org,seller_id:'seller',state:'prepared',account_hash:'a'.repeat(64),mode:'sandbox',banks:['PAN'],application_encrypted:'sealed:'+JSON.stringify({customer:{name:'Fake',cpf:'11111111119'},vehicle:{marca:'Honda',modelo:'CG',ano:2024,preco:18000},banks:['PAN']}),credentials_encrypted:'sealed:'+JSON.stringify({key:'cpk_test_fakekey00'})};state.settings={enabled:true,mode:'sandbox',banks:['PAN']};state.gate=true;state.queries=[];state.post.mockReset().mockResolvedValue(42);state.rpc.mockClear();});
 async function inject(path:string,method:'POST'|'PUT'|'GET'='POST',payload?:any){const app=Fastify();await app.register(routes);try{return await app.inject({method,url:`/organizations/${org}/manual-financing${path}`,headers:{'idempotency-key':id},...(payload?{payload}:{})});}finally{await app.close();}}
 it('blocks cross-organization before reading database',async()=>{state.org=id;expect((await inject('/cases/'+id+'/start')).statusCode).toBe(403);expect(state.queries).toHaveLength(0);expect(state.post).not.toHaveBeenCalled();});
 it('blocks another seller even with the organization isolation flag disabled',async()=>{state.user='other';expect((await inject('/cases/'+id+'/start')).statusCode).toBe(404);expect(state.post).not.toHaveBeenCalled();});
 it('only allows managers to write credentials',async()=>{expect((await inject('/settings','PUT',{key:'secret'})).statusCode).toBe(403);expect(state.queries).toHaveLength(0);});
 it('never posts provider request when gate refuses consent/config/rate claim',async()=>{state.gate=false;expect((await inject('/cases/'+id+'/start')).statusCode).toBe(409);expect(state.post).not.toHaveBeenCalled();});
 it('does not resend existing processing or uncertain consultations',async()=>{for(const status of ['submitting','processing','creation_unknown','completed','cancelled']){state.row.state=status;expect((await inject('/cases/'+id+'/start')).statusCode).toBe(200);}expect(state.post).not.toHaveBeenCalled();expect(state.rpc).not.toHaveBeenCalled();});
 it('makes only one provider POST and records ambiguity without raw error leakage',async()=>{state.post.mockRejectedValue(Error('password-VERY-SECRET'));const response=await inject('/cases/'+id+'/start');expect(state.post).toHaveBeenCalledTimes(1);expect(state.rpc.mock.calls[0][0]).toBe('manual_financing_gate');expect(state.queries.some(q=>q.mutation?.state==='creation_unknown')).toBe(true);expect(response.body).not.toContain('VERY-SECRET');});
 it('rejects customer payload in sandbox before any provider request',async()=>{const app=Fastify();await app.register(routes);const r=await app.inject({method:'POST',url:`/organizations/${org}/manual-financing/cases`,headers:{'idempotency-key':id},payload:{scenario:'approved',banks:['PAN'],customer:{cpf:'52998224725'}}});expect(r.statusCode).toBe(400);expect(state.post).not.toHaveBeenCalled();await app.close();});
 it('identifies connection failures without exposing provider response or credentials',async()=>{state.role='owner';state.settings={...state.settings,account_hash:'a'.repeat(64),credentials_encrypted:'sealed:'+JSON.stringify({key:'cpk_test_fakekey00'})};state.banks.mockRejectedValue(new CredProManualError('sandbox_unconfirmed'));const r=await inject('/settings/test');expect(r.statusCode).toBe(503);expect(r.body).toContain('não identificou a resposta como sandbox');expect(r.body).not.toContain('cpk_test');state.banks.mockRejectedValue(Error('secret-key'));const unknown=await inject('/settings/test');expect(unknown.body).not.toContain('secret-key');});

 function liveVehicle(vehicle:any,banks=['PAN']){
  state.row.mode='live';state.row.banks=banks;
  state.row.application_encrypted='sealed:'+JSON.stringify({customer:{name:'Exemplo',cpf:'52998224725',phone:'11999990000',birthDate:'1985-03-15',hasDriverLicense:true},vehicle,banks});
  state.row.credentials_encrypted='sealed:'+JSON.stringify({key:'cpk_live_fakekey00',banks:banks.map(bank=>({bank,username:'example',password:'fake'}))});
 }
 it('blocks PAN motorcycles without a plate before taking a slot or making a paid request',async()=>{
  for(const condicao of ['novo','usado']){
   liveVehicle({source:'external',tipo:'moto',marca:'Honda',modelo:'CG',ano:2025,preco:21000,condicao});
   const r=await inject('/cases/'+id+'/start');expect(r.statusCode).toBe(409);expect(r.json().error).toContain('PAN');
  }
  expect(state.rpc).not.toHaveBeenCalled();expect(state.post).not.toHaveBeenCalled();
 });
 it('sends a used plated motorcycle through the documented path without returning the private plate',async()=>{
  liveVehicle({source:'stock',tipo:'moto',marca:'Honda',modelo:'CG 160',versao:'Titan',ano:2025,preco:21000,condicao:'usado',placa:'ABC1D23'});
  const r=await inject('/cases/'+id+'/start');expect(r.statusCode).toBe(200);
  expect(state.post).toHaveBeenCalledWith(expect.objectContaining({placa:'ABC1D23',veiculo_modelo:'CG 160 Titan'}));
  expect(r.body).not.toContain('ABC1D23');expect(r.json().vehicle).toMatchObject({condicao:'usado',hasPlate:true});
 });
 it('keeps other banks available for a new motorcycle without a plate',async()=>{
  liveVehicle({source:'external',tipo:'moto',marca:'Honda',modelo:'CG',ano:2026,preco:21000,condicao:'novo'},['BV']);
  expect((await inject('/cases/'+id+'/start')).statusCode).toBe(200);expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.post.mock.calls[0][0]).not.toHaveProperty('placa');
 });
 it('requires legacy prepared live cases to be reviewed again, without resubmitting old cases',async()=>{
  liveVehicle({source:'external',tipo:'moto',marca:'Honda',modelo:'CG',ano:2025,preco:21000,placa:'ABC1D23'});
  expect((await inject('/cases/'+id+'/start')).statusCode).toBe(409);expect(state.post).not.toHaveBeenCalled();
 });
 it('rejects an incompatible mixed-bank application before saving instead of silently omitting PAN',async()=>{
  state.row=null;state.settings={enabled:true,mode:'live',banks:['PAN','BV']};
  const r=await inject('/cases','POST',{customer:{name:'Exemplo',cpf:'52998224725',phone:'11999990000',birthDate:'1985-03-15',hasDriverLicense:true},vehicle:{source:'external',tipo:'moto',marca:'Honda',modelo:'CG 160',ano:2026,preco:21000,condicao:'novo'},banks:['PAN','BV'],consent:{confirmed:true,evidence:'Autorização fictícia para teste local',expiresAt:'2030-12-31T18:00:00Z'}});
  expect(r.statusCode).toBe(400);expect(r.json()).toMatchObject({notPrepared:true,error:expect.stringContaining('PAN')});
  expect(state.queries.some(q=>q.mutation)).toBe(false);expect(state.post).not.toHaveBeenCalled();
 });
 it('prepares stock details privately without querying or returning private catalog columns',async()=>{
  vi.stubEnv('CATALOG_ORGANIZATION_ID',org);vi.stubEnv('CATALOG_SUPABASE_URL','https://example.supabase.co');vi.stubEnv('CATALOG_SUPABASE_ANON_KEY','fake');
  try{
   state.row=null;state.settings={enabled:true,mode:'live',banks:['PAN'],credentials_encrypted:'sealed:fake',revision:id,account_hash:'a'.repeat(64)};
   const app=Fastify();await app.register(routes);
   try{
    const r=await app.inject({method:'POST',url:`/organizations/${org}/manual-financing/cases`,headers:{'idempotency-key':id},payload:{customer:{name:'Exemplo',cpf:'52998224725',phone:'11999990000',birthDate:'1985-03-15',hasDriverLicense:true},vehicle:{source:'stock',vehicleId:7,condicao:'usado',placa:'abc-1d23'},banks:['PAN'],consent:{confirmed:true,evidence:'Autorização fictícia para teste local',expiresAt:'2030-12-31T18:00:00Z'}}});
    expect(r.statusCode).toBe(201);expect(r.body).not.toContain('ABC1D23');
    expect(state.catalogSelect).toHaveBeenCalledWith('id,marca,modelo,ano,preco,tipo');
    const sealed=state.queries.find(q=>q.mutation?.application_encrypted).mutation.application_encrypted;
    expect(JSON.parse(sealed.replace(/^sealed:/,'' )).vehicle).toMatchObject({marca:'Honda',condicao:'usado',placa:'ABC1D23'});
    expect(state.post).not.toHaveBeenCalled();
   }finally{await app.close();}
  }finally{vi.unstubAllEnvs();}
 });

});
