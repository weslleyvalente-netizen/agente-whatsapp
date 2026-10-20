import type {FastifyInstance} from 'fastify';
import {createClient} from '@supabase/supabase-js';
import {getAdminClient} from '@aula-agente/database';
import {isManager} from '../../lib/lead-visibility.js';

// Registered under the financing plugin authentication hook. Private inventory fields stay in the backend.
export function registerFinancingWorkspace(app:FastifyInstance){
  app.get<{Params:{organizationId:string}}>('/organizations/:organizationId/financing/workspace',async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    const org=req.params.organizationId;
    const membership=req.user.memberships.find(m=>m.organization_id===org);
    if(!membership)return reply.code(403).send({error:'Acesso restrito.'});
    const mode=process.env.FINANCING_MODE==='mock'?'mock':'disabled';
    try{
      let query=getAdminClient().from('opportunities').select('id,operation,owner_id,wa_contacts(name)')
        .eq('organization_id',org).eq('status','open').not('owner_id','is',null)
        .in('operation',['vehicle_sale','financing']).order('created_at',{ascending:false}).limit(501);
      if(!isManager(membership.role))query=query.eq('owner_id',req.user.id);
      const {data,error}=await query;
      if(error)throw new Error('workspace');
      const opportunities=data??[];
      const base={mode,userId:req.user.id,opportunities:opportunities.slice(0,500),hasMore:opportunities.length>500};
      if(mode!=='mock'||process.env.CATALOG_ORGANIZATION_ID!==org||!process.env.CATALOG_SUPABASE_URL||!process.env.CATALOG_SUPABASE_SERVICE_ROLE_KEY)
        return {...base,inventoryAvailable:false,vehicles:[]};
      try{
        const catalog=createClient(process.env.CATALOG_SUPABASE_URL,process.env.CATALOG_SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
        const result=await catalog.from('vehicles').select('id,marca,modelo,ano,preco,tipo').eq('status','available').order('modelo').limit(501);
        if(result.error)throw new Error('inventory');
        return {...base,inventoryAvailable:true,vehicles:(result.data??[]).slice(0,500),vehiclesHasMore:(result.data??[]).length>500};
      }catch{return {...base,inventoryAvailable:false,vehicles:[]};}
    }catch{return reply.code(503).send({error:'Não foi possível carregar as oportunidades de financiamento.'});}
  });
}
