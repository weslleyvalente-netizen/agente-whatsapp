import {it,expect,vi,beforeEach} from 'vitest';
import Fastify from 'fastify';
const m=vi.hoisted(()=>({getOpportunityById:vi.fn(),freezeOpportunity:vi.fn()}));
vi.mock('@aula-agente/database',()=>({...m,getAdminClient:()=>({}),createOpportunity:vi.fn(),updateOpportunity:vi.fn(),addOpportunityEvent:vi.fn(),getUnidentifiedSalesContacts:vi.fn(),getOrganizationById:vi.fn(),getOpportunitiesByOrganization:vi.fn(),getContactById:vi.fn(),getQualificationByConversationId:vi.fn(),getOpportunityEvents:vi.fn(),getOpenTasksByContact:vi.fn(),decryptCpf:vi.fn()}));
vi.mock('../../middleware/auth.js',()=>({authMiddleware:async(req:any)=>{req.user={id:'actor',memberships:[{organization_id:'org'}]}}}));
import routes from './index.js';
beforeEach(()=>{vi.clearAllMocks();m.getOpportunityById.mockResolvedValue({id:'opp',organization_id:'org'});m.freezeOpportunity.mockResolvedValue({id:'opp',frozen_until:'2099-10-10'});});
async function request(payload:unknown){const app=Fastify();await app.register(routes);const result=await app.inject({method:'POST',url:'/opportunities/opp/freeze',payload:payload as any});await app.close();return result;}
it('congela com data e motivo e retorna o negócio',async()=>{const res=await request({date:'2099-10-10',reason:'Cliente pediu retorno'});expect(res.statusCode).toBe(200);expect(res.json().frozen_until).toBe('2099-10-10');});
it('recusa dia inexistente e motivo vazio',async()=>{for(const payload of [{date:'2099-02-30',reason:'Retorno'},{date:'2099-10-10',reason:' '}])expect((await request(payload)).statusCode).toBe(400)});
it('recusa organização de outro usuário',async()=>{m.getOpportunityById.mockResolvedValue({id:'opp',organization_id:'other'});expect((await request({date:'2099-10-10',reason:'Retorno'})).statusCode).toBe(403)});
