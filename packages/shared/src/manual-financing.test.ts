import {describe,it,expect} from 'vitest';
import {manualLiveSchema,manualSandboxSchema,manualSettingsSchema} from './manual-financing.js';
const person={name:'Cliente exemplo',cpf:'52998224725',phone:'11999990000',birthDate:'1985-03-15',hasDriverLicense:true};
const form={customer:person,vehicle:{source:'external',tipo:'moto',marca:'Honda',modelo:'CG 160',ano:2025,preco:21000,condicao:'usado',placa:'abc-1d23'},banks:['PAN'],consent:{confirmed:true,evidence:'Autorização registrada no atendimento',expiresAt:'2030-12-31T18:00:00Z'}};
describe('manual financing input',()=>{
 it('requires explicit consent and exactly one vehicle source',()=>{expect(manualLiveSchema.safeParse(form).success).toBe(true);expect(manualLiveSchema.safeParse({...form,consent:{...form.consent,confirmed:false}}).success).toBe(false);expect(manualLiveSchema.safeParse({...form,vehicle:{...form.vehicle,vehicleId:7}}).success).toBe(false);});
 it('validates CPF, date, phone, year, positive price and duplicate banks',()=>{for(const invalid of [{...form,customer:{...person,cpf:'11111111111'}},{...form,customer:{...person,birthDate:'2025-02-30'}},{...form,customer:{...person,phone:'123'}},{...form,vehicle:{...form.vehicle,ano:1800}},{...form,vehicle:{...form.vehicle,preco:0}},{...form,banks:['PAN','PAN']}])expect(manualLiveSchema.safeParse(invalid).success).toBe(false);});
 it('allows private vehicle details on stock references without trusting catalog fields from the browser',()=>{expect(manualLiveSchema.parse({...form,vehicle:{source:'stock',vehicleId:7,condicao:'usado',placa:'abc-1d23'}}).vehicle).toEqual({source:'stock',vehicleId:7,condicao:'usado',placa:'ABC1D23'});expect(manualLiveSchema.safeParse({...form,vehicle:{source:'stock',vehicleId:7,condicao:'usado',preco:1}}).success).toBe(false);});
 it('requires an explicit new or used selection, independently of stock source',()=>{
  for(const source of ['external','stock']){
   const vehicle=source==='external'?{...form.vehicle}:{source,vehicleId:7};
   expect(manualLiveSchema.safeParse({...form,vehicle:{...vehicle,condicao:undefined}}).success).toBe(false);
   for(const condicao of ['novo','usado'])expect(manualLiveSchema.safeParse({...form,vehicle:{...vehicle,condicao}}).success).toBe(true);
  }
 });
 it('normalizes valid plates and rejects malformed values instead of silently dropping them',()=>{
  expect(manualLiveSchema.parse(form).vehicle).toMatchObject({placa:'ABC1D23'});
  expect(manualLiveSchema.parse({...form,vehicle:{...form.vehicle,placa:'abc-1234'}}).vehicle).toMatchObject({placa:'ABC1234'});
  for(const placa of ['', 'ABC123', 'ABC12345', 'AB!1D23', 'ABCAD23'])expect(manualLiveSchema.safeParse({...form,vehicle:{...form.vehicle,placa}}).success).toBe(false);
 });
 it('does not accept customer data or real bank credentials in sandbox cases',()=>{expect(manualSandboxSchema.safeParse({scenario:'rejected',banks:['PAN','C6']}).success).toBe(true);expect(manualSandboxSchema.safeParse({scenario:'rejected',banks:['PAN'],customer:person}).success).toBe(false);});
 it('matches key mode and requires actual bank access for live configuration',()=>{expect(manualSettingsSchema.safeParse({mode:'sandbox',enabled:true,key:'cpk_test_abcdefgh',banks:[]}).success).toBe(true);expect(manualSettingsSchema.safeParse({mode:'live',enabled:true,key:'cpk_test_abcdefgh',banks:[]}).success).toBe(false);expect(manualSettingsSchema.safeParse({mode:'live',enabled:true,key:'cpk_live_abcdefgh',banks:[]}).success).toBe(false);});
});
