import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getAdminClient, getOpportunityById, decryptCpf, sealFinancingApplication } from '@aula-agente/database';
import { authMiddleware } from '../../middleware/auth.js';
import { isManager } from '../../lib/lead-visibility.js';

const mockBank = z.enum(['mock-approved','mock-rejected','mock-error','mock-simulation']);
const consentSchema = z.object({
  evidence: z.string().trim().min(10).max(2000), expires_at: z.string().datetime({ offset: true }),
  banks: z.array(mockBank).min(1).max(4).refine(v => new Set(v).size === v.length),
  allow_requery: z.boolean().default(false),
}).strict();
const requestSchema = z.object({ consent_id: z.string().uuid(), vehicle_id: z.number().int().positive().safe() }).strict();

export default async function financingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);
  // Stricter than legacy feature flags: financial data always belongs to its
  // assigned seller or an organization manager. AI cannot call these routes.
  async function authorize(req: FastifyRequest, reply: FastifyReply, id: string) {
    if (!z.string().uuid().safeParse(id).success) { reply.code(404).send({error:'Não encontrado.'}); return null; }
    const db=getAdminClient();
    let opportunity;
    try { opportunity=await getOpportunityById(db,id); } catch { reply.code(404).send({error:'Não encontrado.'}); return null; }
    const membership=req.user.memberships.find(m => m.organization_id===opportunity.organization_id);
    if (!membership || (!isManager(membership.role) && opportunity.owner_id!==req.user.id)) {
      reply.code(403).send({error:'Acesso restrito ao vendedor atribuído.'}); return null;
    }
    return {db,opportunity};
  }
  app.get<{Params:{organizationId:string}}>('/organizations/:organizationId/financing/alerts',async(req,reply)=>{
    const membership=req.user.memberships.find(m=>m.organization_id===req.params.organizationId);
    if(!membership)return reply.code(403).send({error:'Acesso restrito.'});
    let query=getAdminClient().from('financing_alerts')
      .select('request_id,opportunity_id,created_at,opportunities!inner(owner_id,wa_contacts(name)),financing_requests(mode,financing_results(bank,status,offers))')
      .eq('organization_id',req.params.organizationId).order('created_at',{ascending:false}).limit(100);
    if(!isManager(membership.role))query=query.eq('opportunities.owner_id',req.user.id);
    const {data,error}=await query;
    if(error)return reply.code(503).send({error:'Alertas indisponíveis.'});
    return {alerts:data};
  });
  app.post<{Params:{opportunityId:string}}>('/opportunities/:opportunityId/financing/consents',async(req,reply)=>{
    if (process.env.FINANCING_MODE!=='mock') return reply.code(503).send({error:'Financiamento desativado.'});
    const ctx=await authorize(req,reply,req.params.opportunityId); if(!ctx)return;
    const parsed=consentSchema.safeParse(req.body);
    if(!parsed.success || Date.parse(parsed.data.expires_at)<=Date.now()) return reply.code(400).send({error:'Consentimento, bancos e validade são obrigatórios.'});
    if(ctx.opportunity.status!=='open')return reply.code(409).send({error:'Oportunidade encerrada.'});
    const {data,error}=await ctx.db.from('financing_consents').insert({
      ...parsed.data,organization_id:ctx.opportunity.organization_id,opportunity_id:ctx.opportunity.id,recorded_by:req.user.id,
    }).select('id,expires_at,allow_requery,banks').single();
    if(error)return reply.code(503).send({error:'Não foi possível registrar autorização.'});
    return reply.code(201).send({...data,mode:'mock'});
  });
  app.post<{Params:{opportunityId:string}}>('/opportunities/:opportunityId/financing/requests',async(req,reply)=>{
    if(process.env.FINANCING_MODE!=='mock')return reply.code(503).send({error:'Somente o modo mock está disponível.'});
    const ctx=await authorize(req,reply,req.params.opportunityId); if(!ctx)return;
    const parsed=requestSchema.safeParse(req.body), key=z.string().uuid().safeParse(req.headers['idempotency-key']);
    if(!parsed.success || !key.success)return reply.code(400).send({error:'Informe consentimento, veículo e Idempotency-Key UUID.'});
    if(ctx.opportunity.status!=='open' || !ctx.opportunity.owner_id)return reply.code(409).send({error:'Atribua um vendedor a uma oportunidade aberta.'});
    const org=ctx.opportunity.organization_id;
    // Explicit binding: inventory lives in a DIFFERENT Supabase project.
    if(process.env.CATALOG_ORGANIZATION_ID!==org || !process.env.CATALOG_SUPABASE_URL || !process.env.CATALOG_SUPABASE_SERVICE_ROLE_KEY)
      return reply.code(503).send({error:'Estoque interno não configurado para esta organização.'});
    try {
      const catalog=createClient(process.env.CATALOG_SUPABASE_URL,process.env.CATALOG_SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
      const [v,p,c,q]=await Promise.all([
        catalog.from('vehicles').select('id,marca,modelo,ano,preco,tipo,status').eq('id',parsed.data.vehicle_id).eq('status','available').single(),
        catalog.from('vehicle_private').select('placa,fipe').eq('vehicle_id',parsed.data.vehicle_id).maybeSingle(),
        ctx.db.from('wa_contacts').select('id,phone').eq('id',ctx.opportunity.contact_id).eq('organization_id',org).single(),
        ctx.db.from('conversation_qualifications').select('cpf_encrypted,birth_date,has_driver_license,down_payment_amount,target_installment_amount').eq('contact_id',ctx.opportunity.contact_id).eq('organization_id',org).order('updated_at',{ascending:false}).limit(1).maybeSingle(),
      ]);
      if(v.error||p.error||c.error||q.error)throw new Error('snapshot');
      if(!q.data?.cpf_encrypted || !q.data.birth_date)return reply.code(409).send({error:'Complete CPF e nascimento na qualificação antes de preparar a ficha.'});
      const application={ vehicle:{...v.data,private:p.data}, customer:{contact_id:c.data.id,phone:c.data.phone,
        cpf:decryptCpf(q.data.cpf_encrypted),birth_date:q.data.birth_date,has_driver_license:q.data.has_driver_license},
        terms:{down_payment:q.data.down_payment_amount,target_installment:q.data.target_installment_amount} };
      const sealed=sealFinancingApplication(application,parsed.data.consent_id);
      const {data,error}=await ctx.db.rpc('financing_create',{
        p_org:org,p_opp:ctx.opportunity.id,p_consent:parsed.data.consent_id,p_key:key.data,
        p_fingerprint:sealed.fingerprint,p_vehicle:parsed.data.vehicle_id,p_application:sealed.encrypted,
      });
      if(error)return reply.code(409).send({error:'Autorização inválida, oportunidade encerrada ou chave já utilizada com outros dados.'});
      return reply.code(202).send({id:data,mode:'mock'});
    } catch { return reply.code(503).send({error:'Não foi possível preparar a ficha interna.'}); }
  });
  app.get<{Params:{opportunityId:string}}>('/opportunities/:opportunityId/financing',async(req,reply)=>{
    const ctx=await authorize(req,reply,req.params.opportunityId);if(!ctx)return;
    const {data,error}=await ctx.db.from('financing_requests')
      .select('id,vehicle_id,mode,attempt,state,created_at,requery_on,requery_used,financing_results(bank,status,offers),financing_events(event,created_at),financing_alerts(created_at)')
      .eq('organization_id',ctx.opportunity.organization_id).eq('opportunity_id',ctx.opportunity.id).order('created_at',{ascending:false});
    if(error)return reply.code(503).send({error:'Histórico indisponível.'});return {requests:data};
  });
  app.post<{Params:{opportunityId:string}}>('/opportunities/:opportunityId/financing/cancel',async(req,reply)=>{
    const ctx=await authorize(req,reply,req.params.opportunityId);if(!ctx)return;
    const {error}=await ctx.db.rpc('financing_cancel',{p_org:ctx.opportunity.organization_id,p_opp:ctx.opportunity.id});
    if(error)return reply.code(503).send({error:'Não foi possível cancelar.'});return {cancelled:true};
  });
}
