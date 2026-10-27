import {z} from 'zod';
// Official CredPro textual contract verified 21/10/2026. This is not a promise
// that each lender finances every vehicle category or approves a customer.
export const CREDPRO_BANKS=['PAN','C6','Safra','Itaú','Creditas','VW','Santander','Omni','Sicoob','Porto','Porto (Corretor)','BBC','Daycoval','Bradesco','Bradesco Turbo','BV','CrediCarro'] as const;
export const bankSchema=z.enum(CREDPRO_BANKS);
const banks=z.array(bankSchema).min(1).max(17).refine(v=>new Set(v).size===v.length);
export function validCpf(value:string){
 if(!/^\d{11}$/.test(value)||/^(\d)\1{10}$/.test(value))return false;
 for(let size=9;size<=10;size++){let sum=0;for(let i=0;i<size;i++)sum+=Number(value[i])*(size+1-i);const digit=(sum*10)%11; if(Number(value[size])!==(digit===10?0:digit))return false;}return true;
}
function pastDate(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value&&value<new Date().toISOString().slice(0,10);}
// Private details belong to the encrypted financing application, never the catalog.
export const manualVehicleDetailsSchema=z.object({
 condicao:z.enum(['novo','usado']),
 placa:z.string().trim().max(12).transform(v=>v.replace(/[\s-]/g,'').toUpperCase()).pipe(z.string().regex(/^[A-Z]{3}\d[A-Z0-9]\d{2}$/)).optional(),
});
export const manualVehicleSchema=z.object({source:z.literal('external'),tipo:z.enum(['moto','carro','pesado']),marca:z.string().trim().min(1).max(100),modelo:z.string().trim().min(1).max(200),ano:z.number().int().min(1900).refine(y=>y<=new Date().getUTCFullYear()+1),preco:z.number().finite().positive().max(10_000_000),versao:z.string().trim().min(1).max(200).optional(),codigo_fipe:z.string().regex(/^\d{6}-\d$/).optional()}).merge(manualVehicleDetailsSchema).strict();
// Temporary provider limitation observed in production on 26/10/2026. This is
// not a PAN lending restriction. Remove only after CredPro confirms this flow.
export function manualFinancingCompatibility(vehicle:{tipo:string;placa?:string},banks:readonly string[]):string|null{
 return vehicle.tipo==='moto'&&!vehicle.placa?.trim()&&banks.includes('PAN')
  ?'A integração CredPro com o PAN ainda não atende moto sem placa. Desmarque PAN para seguir com os demais bancos ou informe a placa, se o veículo já tiver uma.'
  :null;
}
export const manualLiveSchema=z.object({
 customer:z.object({name:z.string().trim().min(2).max(120),cpf:z.string().refine(validCpf),phone:z.string().regex(/^\d{10,11}$/),birthDate:z.string().refine(pastDate),hasDriverLicense:z.boolean()}).strict(),
 vehicle:z.union([z.object({source:z.literal('stock'),vehicleId:z.number().int().positive().safe()}).merge(manualVehicleDetailsSchema).strict(),manualVehicleSchema]),
 desiredCredit:z.number().finite().positive().max(10_000_000).optional(),banks,
 consent:z.object({confirmed:z.literal(true),evidence:z.string().trim().min(10).max(2000),expiresAt:z.string().datetime({offset:true})}).strict(),
}).strict();
export const manualSandboxSchema=z.object({scenario:z.enum(['approved','rejected','mixed']),banks:z.array(z.enum(['PAN','C6'])).min(1).max(2).refine(v=>new Set(v).size===v.length)}).strict();
export const manualSettingsSchema=z.object({mode:z.enum(['sandbox','live']),enabled:z.boolean(),key:z.string().trim().min(16).max(256),banks:z.array(z.object({bank:bankSchema,username:z.string().trim().min(1).max(256),password:z.string().min(1).max(512)}).strict()).max(17)}).strict().superRefine((value,ctx)=>{
 if(!new RegExp(`^cpk_${value.mode==='sandbox'?'test':'live'}_[A-Za-z0-9_-]{8,}$`).test(value.key))ctx.addIssue({code:'custom',message:'A chave não corresponde ao ambiente.'});
 if(value.mode==='live'&&!value.banks.length)ctx.addIssue({code:'custom',message:'Cadastre pelo menos um acesso bancário.'});
 if(new Set(value.banks.map(b=>b.bank)).size!==value.banks.length)ctx.addIssue({code:'custom',message:'Bancos repetidos.'});
});
export type ManualLiveInput=z.infer<typeof manualLiveSchema>;
export type ManualSettingsInput=z.infer<typeof manualSettingsSchema>;
export type ManualBank=typeof CREDPRO_BANKS[number];
export type ManualCaseState='prepared'|'submitting'|'processing'|'completed'|'creation_unknown'|'failed'|'cancelled';
