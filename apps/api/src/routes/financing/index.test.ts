import Fastify from 'fastify';
import { describe,it,expect,vi,beforeEach } from 'vitest';
const state=vi.hoisted(()=>({owner:'seller-a',org:'org-a',role:'member',user:'seller-a'}));
vi.mock('../../middleware/auth.js',()=>({authMiddleware:async(req:any)=>{req.user={id:state.user,memberships:[{organization_id:'org-a',role:state.role}]};}}));
vi.mock('@aula-agente/database',()=>({
  getAdminClient:()=>({}), decryptCpf:()=>'',sealFinancingApplication:()=>({}),
  getOpportunityById:async()=>({id:'00000000-0000-0000-0000-000000000001',organization_id:state.org,owner_id:state.owner,status:'open'}),
}));
import routes from './index.js';
describe('financing authorization',()=>{
  beforeEach(()=>{state.owner='seller-a';state.org='org-a';state.role='member';state.user='seller-a';delete process.env.FINANCING_MODE;});
  it('blocks another seller even when legacy seller isolation flag is off',async()=>{
    state.user='seller-b';const app=Fastify();await app.register(routes);
    expect((await app.inject('/opportunities/00000000-0000-0000-0000-000000000001/financing')).statusCode).toBe(403);await app.close();
  });
  it('blocks a manager from another organization',async()=>{
    state.role='admin';state.org='org-b';const app=Fastify();await app.register(routes);
    expect((await app.inject('/opportunities/00000000-0000-0000-0000-000000000001/financing')).statusCode).toBe(403);await app.close();
  });
  it('rejects production execution before looking up personal data',async()=>{
    process.env.FINANCING_MODE='production';const app=Fastify();await app.register(routes);
    const response=await app.inject({method:'POST',url:'/opportunities/00000000-0000-0000-0000-000000000001/financing/requests',payload:{}});
    expect(response.statusCode).toBe(503);expect(response.json()).not.toHaveProperty('application_encrypted');await app.close();
  });
});
