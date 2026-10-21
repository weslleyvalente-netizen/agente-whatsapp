import Fastify from 'fastify';
import {describe,it,expect,vi,beforeEach} from 'vitest';
const s=vi.hoisted(()=>({snapshots:[] as any[],rpc:[] as any[],catalogReads:0}));
vi.mock('../../middleware/auth.js',()=>({authMiddleware:async(req:any)=>{req.user={id:'seller-a',memberships:[{organization_id:'org-a',role:'agent'}]};}}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>{s.catalogReads++;throw new Error('Catalog must not be contacted');}}));
vi.mock('@aula-agente/database',()=>({
  getOpportunityById:async()=>({id:'00000000-0000-0000-0000-000000000001',organization_id:'org-a',owner_id:'seller-a',contact_id:'contact-a',status:'open'}),
  getAdminClient:()=>({from:(table:string)=>{const q:any={};for(const method of ['select','eq','order','limit'])q[method]=()=>q;q.single=q.maybeSingle=async()=>({data:table==='wa_contacts'?{id:'contact-a',phone:'fixture-phone'}:{cpf_encrypted:'encrypted-cpf',birth_date:'1985-03-15',has_driver_license:true,down_payment_amount:5000,target_installment_amount:600},error:null});return q;},rpc:async(name:string,args:unknown)=>{s.rpc.push([name,args]);return {data:'request-a',error:null};}}),
  decryptCpf:()=> 'synthetic-cpf',sealFinancingApplication:(application:any)=>{s.snapshots.push(application);return {encrypted:'sealed-application',fingerprint:'fixture-hash'};},
}));
import routes from './index.js';
const opp='00000000-0000-0000-0000-000000000001',consent='00000000-0000-0000-0000-000000000002';
const external={tipo:'moto',marca:'Yamaha',modelo:'Fazer FZ25',ano:2025,preco:24900,versao:'ABS',codigo_fipe:'827112-0'};
describe('external financing vehicle',()=>{
  beforeEach(()=>{s.snapshots=[];s.rpc=[];s.catalogReads=0;process.env.FINANCING_MODE='mock';delete process.env.CATALOG_ORGANIZATION_ID;delete process.env.CATALOG_SUPABASE_URL;delete process.env.CATALOG_SUPABASE_SERVICE_ROLE_KEY;});
  async function post(vehicle:unknown){const app=Fastify();await app.register(routes);const r=await app.inject({method:'POST',url:`/opportunities/${opp}/financing/requests`,headers:{'idempotency-key':'00000000-0000-0000-0000-000000000003'},payload:{consent_id:consent,...vehicle as object}});await app.close();return r;}
  it('accepts an external vehicle without catalog configuration and seals it only in the internal application',async()=>{
    const r=await post({external_vehicle:external});expect(r.statusCode).toBe(202);expect(s.catalogReads).toBe(0);expect(s.rpc[0][1].p_vehicle).toBeNull();expect(s.snapshots[0].vehicle).toMatchObject({...external,source:'external'});
    for(const value of ['synthetic-cpf','sealed-application','Fazer FZ25','codigo_fipe'])expect(r.body).not.toContain(value);
  });
  it('accepts a manual model without version, FIPE value, code or reference date',async()=>{
    const {versao,codigo_fipe,...manual}=external;expect((await post({external_vehicle:manual})).statusCode).toBe(202);
  });
  it.each([{vehicle_id:7,external_vehicle:external},{},{external_vehicle:{...external,ano:1800}},{external_vehicle:{...external,preco:0}},{external_vehicle:{...external,marca:' '}},{external_vehicle:{...external,codigo_fipe:'invalid'}},{external_vehicle:{...external,placa:'ABC1D23'}}])('rejects ambiguous/incomplete input before building a snapshot: %j',async payload=>{
    expect((await post(payload)).statusCode).toBe(400);expect(s.rpc).toHaveLength(0);expect(s.snapshots).toHaveLength(0);expect(s.catalogReads).toBe(0);
  });
});
