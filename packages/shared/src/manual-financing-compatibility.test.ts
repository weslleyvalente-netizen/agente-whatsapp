import {describe,it,expect} from 'vitest';
import {manualFinancingCompatibility} from './manual-financing.js';
describe('CredPro motorcycle compatibility guard',()=>{
 it('rejects PAN without a plate, including mixed bank requests',()=>{
  expect(manualFinancingCompatibility({tipo:'moto'},['PAN','BV'])).toContain('PAN');
  expect(manualFinancingCompatibility({tipo:'moto',placa:' '},['PAN'])).toContain('PAN');
 });
 it('does not generalize the observed PAN motorcycle limitation to other flows',()=>{
  expect(manualFinancingCompatibility({tipo:'moto',placa:'ABC1D23'},['PAN'])).toBeNull();
  expect(manualFinancingCompatibility({tipo:'moto'},['BV','C6'])).toBeNull();
  expect(manualFinancingCompatibility({tipo:'carro'},['PAN'])).toBeNull();
 });
});
