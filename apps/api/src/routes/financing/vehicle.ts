import {z} from 'zod';
export const externalVehicleSchema=z.object({
  tipo:z.enum(['moto','carro','pesado']),marca:z.string().trim().min(1).max(100),modelo:z.string().trim().min(1).max(200),
  ano:z.number().int().min(1900).refine(year=>year<=new Date().getUTCFullYear()+1),
  preco:z.number().finite().positive().max(10_000_000),versao:z.string().trim().min(1).max(200).optional(),
  codigo_fipe:z.string().regex(/^\d{6}-\d$/).optional(),
}).strict();
const consent=z.string().uuid();
export const financingRequestSchema=z.union([
  z.object({consent_id:consent,vehicle_id:z.number().int().positive().safe()}).strict(),
  z.object({consent_id:consent,external_vehicle:externalVehicleSchema}).strict(),
]);

/** Allowlist only. Never return private plate/FIPE payload, encrypted application or customer data. */
export function vehicleSummary(application:unknown,source:'stock'|'external'){
  if(!application||typeof application!=='object')return null;
  const vehicle=(application as Record<string,unknown>).vehicle;
  if(!vehicle||typeof vehicle!=='object')return null;
  const row=vehicle as Record<string,unknown>;
  if(typeof row.marca!=='string'||typeof row.modelo!=='string'||typeof row.ano!=='number')return null;
  return {source,marca:row.marca.slice(0,100),modelo:row.modelo.slice(0,200),ano:row.ano,
    ...(typeof row.versao==='string'?{versao:row.versao.slice(0,200)}:{})};
}
