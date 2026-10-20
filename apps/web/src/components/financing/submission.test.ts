import {describe,expect,it,vi} from 'vitest';
import {createMockSubmission} from './submission';
const input={opportunityId:'opp-a',vehicleId:7,evidence:'Autorização registrada no atendimento.',expiresAt:'2030-10-31T20:00:00Z',banks:['mock-approved'],allowRequery:false};
describe('financing submission lifecycle',()=>{
  it('reuses consent and idempotency key after an ambiguous request failure',async()=>{
    const api=vi.fn().mockResolvedValueOnce({id:'consent-a'}).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({id:'request-a'});
    const submit=createMockSubmission(input,api,()=> 'key-a');
    await expect(submit.run()).rejects.toThrow('network');await submit.run();
    expect(api).toHaveBeenCalledTimes(3);expect(api.mock.calls[1]).toEqual(api.mock.calls[2]);
    expect(api.mock.calls[2][1].headers).toEqual({'Idempotency-Key':'key-a'});
  });
  it('does not duplicate consent or requests on double click or after success',async()=>{
    let finish!:(value:unknown)=>void;
    const api=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({id:'request-a'});
    const submit=createMockSubmission(input,api,()=> 'key-a');const first=submit.run();const second=submit.run();
    finish({id:'consent-a'});await Promise.all([first,second]);await submit.run();expect(api).toHaveBeenCalledTimes(2);
  });
  it('stops before creating a request if the organization or opportunity is switched',async()=>{
    let finish!:(value:unknown)=>void;
    const api=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const submit=createMockSubmission(input,api,()=> 'key-a');const run=submit.run();submit.cancel();finish({id:'consent-a'});
    await expect(run).rejects.toThrow('Seleção alterada');expect(api).toHaveBeenCalledTimes(1);
  });
  it('captures the original values instead of allowing edits to change a retry',async()=>{
    const draft={...input,banks:[...input.banks]};const api=vi.fn().mockResolvedValueOnce({id:'consent-a'}).mockResolvedValue({id:'request-a'});
    const submit=createMockSubmission(draft,api,()=> 'key-a');draft.vehicleId=99;draft.banks.push('mock-rejected');await submit.run();
    expect(JSON.parse(api.mock.calls[0][1].body).banks).toEqual(['mock-approved']);expect(JSON.parse(api.mock.calls[1][1].body).vehicle_id).toBe(7);
  });
});

describe('pending recovery',()=>{
  it('reconciles the original request after navigation without a new consent or POST',async()=>{
    const api=vi.fn().mockResolvedValue({request:{id:'existing-request'}}),clear=vi.fn();
    const submit=createMockSubmission(input,api,()=> 'new-key',{pending:{key:'old-key',consentId:'old-consent',vehicleId:7},save:vi.fn(),clear});
    expect(await submit.run()).toEqual({id:'existing-request'});expect(api).toHaveBeenCalledTimes(1);expect(api.mock.calls[0][0]).toContain('/requests/old-key');expect(clear).toHaveBeenCalled();
  });
  it('persists only references before creating a request; storage failure prevents POST',async()=>{
    const api=vi.fn().mockResolvedValue({id:'consent-a'}),save=vi.fn(()=>{throw new Error('Storage blocked');});
    const submit=createMockSubmission(input,api,()=> 'key-a',{save,clear:vi.fn()});
    await expect(submit.run()).rejects.toThrow('Storage blocked');expect(api).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({key:'key-a',consentId:'consent-a',vehicleId:7});
  });
});
