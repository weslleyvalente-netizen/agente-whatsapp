import { describe, it, expect, vi } from 'vitest';
import { CredProSandboxClient, CredProSandboxError, normalizeSandboxResult } from './credpro-sandbox.js';
const KEY='cpk_test_synthetic_fixture_not_a_real_key';
const payload={consulta_id:123,status:'concluida',sandbox:true,resultados:[
  {banco:'PAN',status:'aprovado',dados:{valor_entrada:'5.000,00',parcelas:'48x de R$ 580,00'}},
  {banco:'C6',status:'recusado',dados:{mensagem_recusa:'fixture'}},
]};
function transport(body:unknown,status=200){return vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status}));}
describe('CredPro sandbox boundary',()=>{
  it('refuses live credentials before any network request',()=>{
    const fetcher=transport({});
    for(const key of ['', 'cpk_live_fixture', ' cpK_test_x']) expect(()=>new CredProSandboxClient({key,fetcher})).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends only fixed synthetic examples, never accepts a customer application',async()=>{
    const fetcher=transport({consulta_id:123,status:'processando',sandbox:true});
    const client=new CredProSandboxClient({key:KEY,fetcher});
    expect(await client.start('approved',['PAN','C6'])).toBe(123);
    const [url,init]=fetcher.mock.calls[0];const body=JSON.parse(init.body);
    expect(url).toBe('https://cred-pro.com/v1/simulacoes');
    expect(body).toMatchObject({cpf:'11111111119',celular:'11999990000',placa:'ABC1D23',data_nascimento:'1985-03-15',tipo_veiculo:'moto',bancos:{PAN:{usuario:'x',senha:'x'},C6:{usuario:'x',senha:'x'}}});
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(client)).not.toContain(KEY);
  });
  it('blocks malformed scenarios, arbitrary banks and duplicate banks',async()=>{
    const fetcher=transport({});const client=new CredProSandboxClient({key:KEY,fetcher});
    for(const [scenario,banks] of [['customer',['PAN']],['approved',['invented']],['approved',['PAN','PAN']],['approved',[]]]) {
      await expect(client.start(scenario as any,banks as any)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires sandbox proof on every response and never repeats an ambiguous POST',async()=>{
    const fetcher=transport({consulta_id:123,status:'processando'});const client=new CredProSandboxClient({key:KEY,fetcher});
    await expect(client.start('rejected',['PAN'])).rejects.toMatchObject({code:'sandbox_unconfirmed'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('polls only consultations created by this sandbox client',async()=>{
    const fetcher=transport(payload);const client=new CredProSandboxClient({key:KEY,fetcher});
    await expect(client.result(123)).rejects.toMatchObject({code:'unknown_consultation'});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not fabricate a 36-month offer from a returned 48-month offer',()=>{
    expect(normalizeSandboxResult(payload).results).toEqual([
      {bank:'PAN',status:'preapproved',providerStatus:'aprovado',offers:[{downPayment:5000,installments:48,installmentAmount:580}]},
      {bank:'C6',status:'rejected',providerStatus:'recusado',offers:[]},
    ]);
  });
  it('keeps pending, simulation and credential failures distinct from refusals',()=>{
    const data={...payload,resultados:[
      {banco:'PAN',status:null},{banco:'C6',status:'simulacao',dados:{}},
      {banco:'BV',status:'credencial_invalida'},{banco:'Itaú',status:'manutencao'},
    ]};
    expect(normalizeSandboxResult(data).results.map(r=>r.status)).toEqual(['pending','simulation','error','error']);
  });
  it('sanitizes HTTP and transport errors without leaking provider bodies or keys',async()=>{
    const fetcher=transport({detail:`secret ${KEY}`},429);const client=new CredProSandboxClient({key:KEY,fetcher});
    try{await client.start('mixed',['PAN']);throw Error('expected failure');}
    catch(error){expect(error).toBeInstanceOf(CredProSandboxError);expect(String(error)).not.toContain(KEY);expect(error).toMatchObject({code:'http_429'});}
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects undecodable and unsafe consultation ids without exposing raw payloads',()=>{
    for(const patch of [{consulta_id:'../customer'},{sandbox:false},{resultados:[{banco:'PAN',status:'invented'}]}]) {
      expect(()=>normalizeSandboxResult({...payload,...patch})).toThrow();
    }
  });
});

describe('CredPro sandbox polling',()=>{
  it('retrieves the created consultation and keeps only returned terms',async()=>{
    vi.useFakeTimers();
    try{
      const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({consulta_id:123,status:'processando',sandbox:true})))
        .mockResolvedValueOnce(new Response(JSON.stringify(payload)));
      const client=new CredProSandboxClient({key:KEY,fetcher});const id=await client.start('approved',['PAN','C6']);
      const pending=client.result(id);await vi.advanceTimersByTimeAsync(3100);
      const result=await pending;
      expect(result.state).toBe('completed');expect(result.results[0].offers).toEqual([{downPayment:5000,installments:48,installmentAmount:580}]);
      expect(fetcher.mock.calls[1][0]).toBe('https://cred-pro.com/v1/simulacoes/123');
      expect(fetcher.mock.calls[1][1].method).toBe('GET');
    }finally{vi.useRealTimers();}
  });
  it('does not accept an incomplete completed response or a changed consultation id',async()=>{
    vi.useFakeTimers();
    try{
      const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({consulta_id:123,status:'processando',sandbox:true})))
        .mockResolvedValueOnce(new Response(JSON.stringify({...payload,resultados:[payload.resultados[0]]})));
      const client=new CredProSandboxClient({key:KEY,fetcher});await client.start('mixed',['PAN','C6']);
      const pending=expect(client.result(123)).rejects.toMatchObject({code:'incomplete_result'});
      await vi.advanceTimersByTimeAsync(3100);await pending;
    }finally{vi.useRealTimers();}
  });
  it('does not retry a POST after transport failure or echo the thrown secret',async()=>{
    const fetcher=vi.fn().mockRejectedValue(Error(`provider echo ${KEY}`));const client=new CredProSandboxClient({key:KEY,fetcher});
    await expect(client.start('approved',['PAN'])).rejects.toMatchObject({code:'creation_unknown'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
