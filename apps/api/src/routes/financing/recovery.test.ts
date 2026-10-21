import Fastify from 'fastify';
import {describe,it,expect,vi,beforeEach} from 'vitest';
const s=vi.hoisted(()=>({user:'seller-a',calls:[] as unknown[][],error:false}));
vi.mock('../../middleware/auth.js',()=>({authMiddleware:async(req:any)=>{req.user={id:s.user,memberships:[{organization_id:'org-a',role:'agent'}]};}}));
vi.mock('@aula-agente/database',()=>({
  getOpportunityById:async()=>({id:'00000000-0000-0000-0000-000000000001',organization_id:'org-a',owner_id:'seller-a',status:'open'}),
  getAdminClient:()=>({from:(table:string)=>{s.calls.push(['from',table]);const q:any={};for(const method of ['select','eq'])q[method]=(...args:unknown[])=>{s.calls.push([method,...args]);return q;};q.maybeSingle=async()=>({data:{id:'existing-request'},error:s.error?{}:null});return q;}}),decryptCpf:vi.fn(),sealFinancingApplication:vi.fn(),
}));
import routes from './index.js';
const opp='00000000-0000-0000-0000-000000000001',key='00000000-0000-0000-0000-000000000002';
describe('request recovery',()=>{
  beforeEach(()=>{s.user='seller-a';s.calls=[];s.error=false;});
  async function get(requestKey=key){const app=Fastify();await app.register(routes);const r=await app.inject(`/opportunities/${opp}/financing/requests/${requestKey}`);await app.close();return r;}
  it('reconciles only by organization, opportunity and original idempotency key',async()=>{
    const r=await get();expect(r.json()).toEqual({request:{id:'existing-request'}});expect(r.headers['cache-control']).toBe('no-store');
    expect(s.calls).toContainEqual(['eq','organization_id','org-a']);expect(s.calls).toContainEqual(['eq','opportunity_id',opp]);expect(s.calls).toContainEqual(['eq','idempotency_key',key]);expect(s.calls).toContainEqual(['select','id']);
  });
  it('prevents recovery of another sellers attempt',async()=>{s.user='seller-b';expect((await get()).statusCode).toBe(403);expect(s.calls).toEqual([]);});
  it('rejects malformed keys before database lookup',async()=>{expect((await get('invalid')).statusCode).toBe(400);expect(s.calls).toEqual([]);});
  it('does not turn database failure into missing request',async()=>{s.error=true;expect((await get()).statusCode).toBe(503);});
});
