import Fastify from 'fastify';
import {describe,it,expect,vi,beforeEach} from 'vitest';
const s=vi.hoisted(()=>({unreadable:false,user:'seller-a'}));
vi.mock('../../middleware/auth.js',()=>({authMiddleware:async(req:any)=>{req.user={id:s.user,memberships:[{organization_id:'org-a',role:'agent'}]};}}));
vi.mock('@aula-agente/database',()=>({
  getOpportunityById:async()=>({id:'00000000-0000-0000-0000-000000000001',organization_id:'org-a',owner_id:'seller-a'}),
  getAdminClient:()=>({from:()=>{const q:any={};for(const method of ['select','eq','order'])q[method]=()=>q;q.then=(resolve:any)=>resolve({data:[{id:'request-a',vehicle_id:null,vehicle_source:'external',application_encrypted:'private-ciphertext',state:'queued'}],error:null});return q;}}),
  openFinancingApplication:()=>{if(s.unreadable)throw new Error('private-error');return {customer:{cpf:'private-cpf',phone:'private-phone'},vehicle:{marca:'Yamaha',modelo:'Fazer FZ25',ano:2025,private:{placa:'private-plate'},codigo_fipe:'827112-0'}};},
  decryptCpf:vi.fn(),sealFinancingApplication:vi.fn(),
}));
import routes from './index.js';
describe('private history projection',()=>{
  beforeEach(()=>{s.unreadable=false;s.user='seller-a';});
  async function get(){const app=Fastify();await app.register(routes);const r=await app.inject('/opportunities/00000000-0000-0000-0000-000000000001/financing');await app.close();return r;}
  it('returns a vehicle summary and never ciphertext, customer or private vehicle fields',async()=>{
    const r=await get();expect(r.statusCode).toBe(200);expect(r.json().requests[0].vehicle).toEqual({source:'external',marca:'Yamaha',modelo:'Fazer FZ25',ano:2025});
    expect(r.body).not.toContain('private-');expect(r.body).not.toContain('application_encrypted');expect(r.body).not.toContain('codigo_fipe');expect(r.headers['cache-control']).toBe('no-store');
  });
  it('preserves history if a legacy snapshot cannot be opened',async()=>{s.unreadable=true;const r=await get();expect(r.json().requests[0].vehicle).toBeNull();expect(r.body).not.toContain('private-');});
  it('blocks another seller before opening the encrypted application',async()=>{s.user='seller-b';expect((await get()).statusCode).toBe(403);});
});
