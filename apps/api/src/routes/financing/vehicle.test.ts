import {describe,it,expect} from 'vitest';
import {vehicleSummary} from './vehicle.js';
describe('internal vehicle history summary',()=>{
  it('projects only model fields and never customer, plate, FIPE payload or value',()=>{
    const application={customer:{cpf:'secret'},vehicle:{marca:'Yamaha',modelo:'Fazer FZ25',ano:2025,versao:'ABS',preco:24900,codigo_fipe:'827112-0',private:{placa:'secret',fipe:{}}}};
    expect(vehicleSummary(application,'external')).toEqual({source:'external',marca:'Yamaha',modelo:'Fazer FZ25',ano:2025,versao:'ABS'});
  });
  it('handles a legacy or unreadable application without exposing the raw value',()=>{expect(vehicleSummary({customer:{cpf:'secret'}},'stock')).toBeNull();expect(vehicleSummary(null,'external')).toBeNull();});
});
