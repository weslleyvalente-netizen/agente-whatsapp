import {describe,it,expect} from 'vitest';
import {providerPayload,publicCase,sandboxApplication} from './payload.js';
describe('manual financing provider boundary',()=>{
 it('uses only documented fields and never confuses price/code with FIPE value',()=>{
  const a=sandboxApplication('approved',['PAN']);
  const p=providerPayload({...a,desiredCredit:15000},{},'sandbox');
  expect(p).toEqual({cpf:a.customer.cpf,celular:a.customer.phone,data_nascimento:'1990-01-01',tipo_veiculo:'moto',possui_cnh:true,veiculo_marca:'Honda',veiculo_modelo:'CG 160',veiculo_ano:2024,valor_desejado:15000,bancos:{PAN:{usuario:'x',senha:'x'}}});
  expect(p).not.toHaveProperty('fipe_value');expect(p).not.toHaveProperty('placa');
 });
 it('uses documented sandbox outcome suffixes',()=>{expect(sandboxApplication('approved',[]).customer.cpf).toMatch(/9$/);expect(sandboxApplication('rejected',[]).customer.cpf).toMatch(/0$/);});
 it('only projects masked customer fields and drops results after revocation',()=>{
  const a=sandboxApplication('mixed',[]),r=publicCase({id:'1',application_encrypted:'secret',credentials_encrypted:'key',revoked_at:'now',results:[{bank:'PAN'}]},a);
  expect(JSON.stringify(r)).not.toContain(a.customer.cpf);expect(r.results).toEqual([]);expect(r.customer).not.toHaveProperty('phone');expect(r).not.toHaveProperty('credentials_encrypted');
 });
});
