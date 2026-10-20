import Fastify from 'fastify';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const s=vi.hoisted(()=>({user:'seller-a',role:'agent',org:'org-a',calls:[] as unknown[][],catalogCalls:[] as unknown[][],error:false,catalogError:false}));
vi.mock('../../middleware/auth.js',()=>({authMiddleware:async(req:any)=>{req.user={id:s.user,memberships:[{organization_id:s.org,role:s.role}]};}}));
function query(catalog=false){
  const calls=catalog?s.catalogCalls:s.calls;
  const q:any={};
  for(const method of ['select','eq','not','in','order','limit'])q[method]=(...args:unknown[])=>{calls.push([method,...args]);return q;};
  q.then=(resolve:any)=>resolve({data:[],error:(catalog?s.catalogError:s.error)?{message:'secret database detail'}:null});
  return q;
}
vi.mock('@aula-agente/database',()=>({getAdminClient:()=>({from:(table:string)=>{s.calls.push(['from',table]);return query();}}),getOpportunityById:vi.fn(),decryptCpf:vi.fn(),sealFinancingApplication:vi.fn()}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({from:(table:string)=>{s.catalogCalls.push(['from',table]);return query(true);}})}));
import routes from './index.js';
describe('financing seller workspace',()=>{
  beforeEach(()=>{s.role='agent';s.org='org-a';s.calls=[];s.catalogCalls=[];s.error=false;s.catalogError=false;process.env.FINANCING_MODE='mock';process.env.CATALOG_ORGANIZATION_ID='org-a';process.env.CATALOG_SUPABASE_URL='https://example.test';process.env.CATALOG_SUPABASE_SERVICE_ROLE_KEY='test-service-key';});
  async function get(){const app=Fastify();await app.register(routes);const response=await app.inject('/organizations/org-a/financing/workspace');await app.close();return response;}
  it('restricts sellers to own open assigned opportunities even with legacy isolation disabled',async()=>{
    const r=await get();expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({mode:'mock',opportunities:[],vehicles:[]});
    expect(s.calls).toContainEqual(['eq','owner_id','seller-a']);expect(s.calls).toContainEqual(['eq','organization_id','org-a']);expect(s.calls).toContainEqual(['eq','status','open']);
  });
  it('allows organization managers to view only assigned open opportunities',async()=>{
    s.role='admin';expect((await get()).statusCode).toBe(200);expect(s.calls).not.toContainEqual(['eq','owner_id','seller-a']);expect(s.calls).toContainEqual(['not','owner_id','is',null]);
  });
  it('rejects other organizations before any reads',async()=>{s.org='org-b';expect((await get()).statusCode).toBe(403);expect(s.calls).toEqual([]);expect(s.catalogCalls).toEqual([]);});
  it('never selects private vehicle/customer fields',async()=>{
    await get();expect(s.catalogCalls).toContainEqual(['from','vehicles']);expect(s.catalogCalls).toContainEqual(['select','id,marca,modelo,ano,preco,tipo']);expect(s.catalogCalls).toContainEqual(['eq','status','available']);
    const reads=JSON.stringify([...s.calls,...s.catalogCalls]);for(const text of ['vehicle_private','cpf','placa','fipe','phone','*'])expect(reads).not.toContain(text);
  });
  it('keeps production disabled and avoids the inventory service',async()=>{process.env.FINANCING_MODE='production';const r=await get();expect(r.json().mode).toBe('disabled');expect(s.catalogCalls).toEqual([]);});
  it('does not cross the explicit catalog organization binding',async()=>{process.env.CATALOG_ORGANIZATION_ID='org-b';const r=await get();expect(r.json()).toMatchObject({mode:'mock',inventoryAvailable:false,vehicles:[]});expect(s.catalogCalls).toEqual([]);});
  it('fails closed and sanitizes database failures',async()=>{s.error=true;const r=await get();expect(r.statusCode).toBe(503);expect(r.body).not.toContain('secret');});
  it('keeps inventory failure distinct from empty inventory',async()=>{s.catalogError=true;const r=await get();expect(r.statusCode).toBe(200);expect(r.json().inventoryAvailable).toBe(false);expect(r.body).not.toContain('secret');});
});
