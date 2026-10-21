import Fastify from 'fastify';
import {describe,it,expect,vi,beforeEach} from 'vitest';
const org='00000000-0000-0000-0000-000000000001',id='00000000-0000-0000-0000-000000000002';
const state=vi.hoisted(()=>({role:'member',user:'seller',org:'00000000-0000-0000-0000-000000000001',row:null as any,settings:null as any,gate:true,post:vi.fn(),rpc:vi.fn(),queries:[] as any[]}));
vi.mock('../../middleware/auth.js',()=>({authMiddleware:async(req:any)=>{req.user={id:state.user,memberships:[{organization_id:state.org,role:state.role}]};}}));
vi.mock('@aula-agente/database',()=>({
 encryptCpf:(s:string)=>'sealed:'+s,decryptCpf:(s:string)=>s.replace(/^sealed:/,''),hashCpf:()=> 'a'.repeat(64),
 CredProManualClient:class{start=state.post;},CredProManualError:class extends Error{},
 getAdminClient:()=>({rpc:async(name:string,args:any)=>{state.rpc(name,args);return {data:name==='manual_financing_gate'?state.gate:true,error:null};},from:(table:string)=>{
  const filters:Record<string,unknown>={};let mutation:any;
  const result=()=>{state.queries.push({table,filters,mutation});const row=table==='manual_financing_settings'?state.settings:state.row;return {data:row&&(!filters.seller_id||filters.seller_id===row.seller_id)?row:null,error:null};};
  const q:any={select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},maybeSingle:async()=>result(),single:async()=>result(),update:(v:any)=>{mutation=v;return q;},upsert:(v:any)=>{mutation=v;return q;},then:(resolve:any)=>Promise.resolve(result()).then(resolve)};return q;
 }})
}));
import routes from './index.js';
describe('manual financing authorization and dispatch',()=>{
 beforeEach(()=>{state.role='member';state.user='seller';state.org=org;state.row={id,organization_id:org,seller_id:'seller',state:'prepared',account_hash:'a'.repeat(64),mode:'sandbox',banks:['PAN'],application_encrypted:'sealed:'+JSON.stringify({customer:{name:'Fake',cpf:'11111111119'},vehicle:{marca:'Honda',modelo:'CG',ano:2024,preco:18000},banks:['PAN']}),credentials_encrypted:'sealed:'+JSON.stringify({key:'cpk_test_fakekey00'})};state.settings={enabled:true,mode:'sandbox',banks:['PAN']};state.gate=true;state.queries=[];state.post.mockReset().mockResolvedValue(42);state.rpc.mockClear();});
 async function inject(path:string,method:'POST'|'PUT'|'GET'='POST',payload?:any){const app=Fastify();await app.register(routes);try{return await app.inject({method,url:`/organizations/${org}/manual-financing${path}`,...(payload?{payload}:{})});}finally{await app.close();}}
 it('blocks cross-organization before reading database',async()=>{state.org=id;expect((await inject('/cases/'+id+'/start')).statusCode).toBe(403);expect(state.queries).toHaveLength(0);expect(state.post).not.toHaveBeenCalled();});
 it('blocks another seller even with the organization isolation flag disabled',async()=>{state.user='other';expect((await inject('/cases/'+id+'/start')).statusCode).toBe(404);expect(state.post).not.toHaveBeenCalled();});
 it('only allows managers to write credentials',async()=>{expect((await inject('/settings','PUT',{key:'secret'})).statusCode).toBe(403);expect(state.queries).toHaveLength(0);});
 it('never posts provider request when gate refuses consent/config/rate claim',async()=>{state.gate=false;expect((await inject('/cases/'+id+'/start')).statusCode).toBe(409);expect(state.post).not.toHaveBeenCalled();});
 it('does not resend existing processing or uncertain consultations',async()=>{for(const status of ['submitting','processing','creation_unknown','completed','cancelled']){state.row.state=status;expect((await inject('/cases/'+id+'/start')).statusCode).toBe(200);}expect(state.post).not.toHaveBeenCalled();expect(state.rpc).not.toHaveBeenCalled();});
 it('makes only one provider POST and records ambiguity without raw error leakage',async()=>{state.post.mockRejectedValue(Error('password-VERY-SECRET'));const response=await inject('/cases/'+id+'/start');expect(state.post).toHaveBeenCalledTimes(1);expect(state.rpc.mock.calls[0][0]).toBe('manual_financing_gate');expect(state.queries.some(q=>q.mutation?.state==='creation_unknown')).toBe(true);expect(response.body).not.toContain('VERY-SECRET');});
 it('rejects customer payload in sandbox before any provider request',async()=>{const app=Fastify();await app.register(routes);const r=await app.inject({method:'POST',url:`/organizations/${org}/manual-financing/cases`,headers:{'idempotency-key':id},payload:{scenario:'approved',banks:['PAN'],customer:{cpf:'52998224725'}}});expect(r.statusCode).toBe(400);expect(state.post).not.toHaveBeenCalled();await app.close();});
});
