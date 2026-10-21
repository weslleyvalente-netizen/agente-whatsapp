import {describe,it,expect} from 'vitest';
import {pendingStore} from './pending';
describe('pending financing reference',()=>{
  it('survives recreation and remains separated by user, organization and opportunity',()=>{
    const data=new Map<string,string>();const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};
    const ref={key:'00000000-0000-0000-0000-000000000001',consentId:'00000000-0000-0000-0000-000000000002',vehicleId:7};
    pendingStore(storage,'user','org','opp').save(ref);
    expect(pendingStore(storage,'user','org','opp').load()).toEqual(ref);
    for(const args of [['other','org','opp'],['user','other','opp'],['user','org','other']])expect(pendingStore(storage,...args as [string,string,string]).load()).toBeNull();
    expect([...data.values()]).toEqual([JSON.stringify(ref)]);
    pendingStore(storage,'user','org','opp').save({...ref,vehicleId:null});
    expect(pendingStore(storage,'user','org','opp').load()?.vehicleId).toBeNull();
    pendingStore(storage,'user','org','opp').clear();expect(data.size).toBe(0);
  });
});
