import {describe,it,expect} from 'vitest';
import {externalVehicleFromDraft} from './vehicle';
const draft={tipo:'moto',marca:' Yamaha ',modelo:'Fazer FZ25',ano:'2025',preco:'24900.50',versao:'',codigo_fipe:''};
describe('external vehicle form',()=>{
  it('accepts a complete manual model without FIPE/price reference date',()=>{
    expect(externalVehicleFromDraft(draft)).toEqual({tipo:'moto',marca:'Yamaha',modelo:'Fazer FZ25',ano:2025,preco:24900.5});
  });
  it.each([{...draft,ano:'1800'},{...draft,ano:'2025.5'},{...draft,preco:'0'},{...draft,preco:'NaN'},{...draft,marca:''},{...draft,codigo_fipe:'not-a-code'},{...draft,tipo:'unsupported'}])('keeps incomplete or invalid form from being submitted',value=>{expect(externalVehicleFromDraft(value)).toBeNull();});
  it('preserves optional version and manually supplied FIPE code',()=>{expect(externalVehicleFromDraft({...draft,versao:' ABS ',codigo_fipe:'827112-0'})).toMatchObject({versao:'ABS',codigo_fipe:'827112-0'});});
});
