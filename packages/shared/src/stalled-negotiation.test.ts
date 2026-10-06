import {describe,it,expect} from 'vitest';
import {shouldAlertStalledNegotiation as alert} from './stalled-negotiation.js';
const ev={customerMessages:['Quero a Fazer 250 para trabalhar','qual a parcela de 36 meses?'],humanMessageCount:0,openOpportunityStages:['simulation_sent']};
describe('stalled negotiation alert',()=>{
 it('alerts for an engaged customer with an advanced deal',()=>{expect(alert(ev)).toBe(true);});
 it('alerts for an engaged customer already attended by a human',()=>{expect(alert({...ev,openOpportunityStages:['qualification'],humanMessageCount:2})).toBe(true);expect(alert({...ev,openOpportunityStages:[],humanMessageCount:1})).toBe(true);});
 it('does not alert when the deal never advanced and no human attended',()=>{
  expect(alert({...ev,openOpportunityStages:['qualification']})).toBe(false);
  expect(alert({...ev,openOpportunityStages:[]})).toBe(false);
 });
 it('does not alert for a customer who barely engaged',()=>{
  expect(alert({...ev,customerMessages:['[Cliente veio de um anúncio: X]\nComo funciona o consórcio?']})).toBe(false);
  expect(alert({...ev,customerMessages:['[Cliente veio de um anúncio: X]\nOi','ok','Obrigado!']})).toBe(false);
  expect(alert({...ev,customerMessages:['quero saber o valor da parcela']})).toBe(false);
 });
});
