import {describe,it,expect} from 'vitest';
import {manualVehicleFromDraft} from './vehicle';
const draft={tipo:'moto',marca:'Honda',modelo:'CG 160',ano:'2026',preco:'21000',versao:'Titan',codigo_fipe:''};
describe('manual financing vehicle intent',()=>{
 it('preserves a private normalized plate and version on an external used vehicle',()=>{
  expect(manualVehicleFromDraft({source:'external',vehicleId:'',draft,condicao:'usado',placa:'abc-1d23'})).toEqual({source:'external',tipo:'moto',marca:'Honda',modelo:'CG 160',ano:2026,preco:21000,versao:'Titan',condicao:'usado',placa:'ABC1D23'});
 });
 it('allows a new motorcycle without requiring plate, FIPE valuation or reference date',()=>{
  expect(manualVehicleFromDraft({source:'external',vehicleId:'',draft,condicao:'novo',placa:' '})).toMatchObject({condicao:'novo'});
  expect(manualVehicleFromDraft({source:'external',vehicleId:'',draft,condicao:'novo',placa:''})).not.toHaveProperty('placa');
 });
 it('only sends the stock reference and private details, not editable catalog identity or price',()=>{
  expect(manualVehicleFromDraft({source:'stock',vehicleId:'7',draft,condicao:'usado',placa:'ABC1234'})).toEqual({source:'stock',vehicleId:7,condicao:'usado',placa:'ABC1234'});
 });
 it.each([
  {source:'external',vehicleId:'',draft,condicao:'',placa:''},
  {source:'external',vehicleId:'',draft,condicao:'usado',placa:'ABC'},
  {source:'external',vehicleId:'',draft:{...draft,modelo:''},condicao:'novo',placa:''},
  {source:'stock',vehicleId:'',draft,condicao:'usado',placa:''},
 ])('rejects incomplete identity, condition, plate or stock reference',input=>{
  expect(manualVehicleFromDraft(input)).toBeNull();
 });
});
