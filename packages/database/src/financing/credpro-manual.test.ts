import {describe,it,expect,vi} from 'vitest';
import {CredProManualClient,normalizeCredProManualResult} from './credpro-manual.js';
const row={consulta_id:42,status:'concluida',resultados:[{banco:'PAN',status:'aprovado',dados:{valor_entrada:'9.000,00',parcelas:'48x de R$ 1.120,00'}}]};
describe('documented CredPro manual transport',()=>{
 it('rejects a mode/key mismatch before network',()=>{const fetcher=vi.fn();expect(()=>new CredProManualClient('sandbox','cpk_live_abcdefgh',fetcher)).toThrow();expect(fetcher).not.toHaveBeenCalled();});
 it('never repeats an ambiguous creation and sanitizes its error',async()=>{const fetcher=vi.fn().mockRejectedValue(new Error('secret payload'));const client=new CredProManualClient('live','cpk_live_abcdefgh',fetcher);await expect(client.start({bancos:{PAN:{usuario:'private',senha:'private'}}})).rejects.toThrow('creation_unknown');expect(fetcher).toHaveBeenCalledTimes(1);});
 it('uses only fixed documented HTTPS paths and rejects redirects',async()=>{const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({consulta_id:42,status:'processando'})));await new CredProManualClient('live','cpk_live_abcdefgh',fetcher).start({bancos:{PAN:{usuario:'x',senha:'x'}}});expect(fetcher.mock.calls[0][0]).toBe('https://cred-pro.com/v1/simulacoes');expect(fetcher.mock.calls[0][1].redirect).toBe('error');});
 it('requires a sandbox marker and forbids sandbox results in live mode',()=>{expect(()=>normalizeCredProManualResult(row,'sandbox',['PAN'])).toThrow('sandbox_unconfirmed');expect(()=>normalizeCredProManualResult({...row,sandbox:true},'live',['PAN'])).toThrow('wrong_environment');});
 it('returns only actual terms without fabricating 36 installments or exposing raw fields',()=>{const r=normalizeCredProManualResult({...row,cpf:'private-cpf'},'live',['PAN']);expect(r.results[0].offers).toEqual([{downPayment:9000,installments:48,installmentAmount:1120}]);expect(JSON.stringify(r)).not.toContain('private-cpf');});
 it('keeps credential/technical errors separate from refusal and requires all requested banks on completion',()=>{expect(normalizeCredProManualResult({...row,resultados:[{banco:'PAN',status:'credencial_invalida'}]},'live',['PAN']).results[0].status).toBe('error');expect(()=>normalizeCredProManualResult(row,'live',['PAN','C6'])).toThrow('incomplete_result');});
 it('only releases documented pre-creation failures, never generic HTTP failures',async()=>{
  const known=new CredProManualClient('sandbox','cpk_test_fakekey00',async()=>new Response(JSON.stringify({detail:{erro:{codigo:'chave_invalida',mensagem:'secret'}}}),{status:401}));
  await expect(known.start({})).rejects.toMatchObject({code:'not_created_401'});
  const unknown=new CredProManualClient('sandbox','cpk_test_fakekey00',async()=>new Response('gateway secret',{status:500}));
  await expect(unknown.start({})).rejects.toMatchObject({code:'http_500'});
 });

 it('accepts environment-neutral bank availability but keeps credit sandbox guards strict',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({bancos:[{banco:'PAN',disponivel_agora:true}]})));
  const client=new CredProManualClient('sandbox','cpk_test_fakekey00',fetcher);
  await expect(client.banks()).resolves.toEqual([{bank:'PAN',available:true}]);
  expect(fetcher.mock.calls[0][1].method).toBe('GET');expect(fetcher.mock.calls[0][0]).toBe('https://cred-pro.com/v1/bancos');
  const explicitWrong=new CredProManualClient('sandbox','cpk_test_fakekey00',async()=>new Response(JSON.stringify({sandbox:false,bancos:[]})));
  await expect(explicitWrong.banks()).rejects.toMatchObject({code:'sandbox_unconfirmed'});
  const noMarker=new CredProManualClient('sandbox','cpk_test_fakekey00',async()=>new Response(JSON.stringify({consulta_id:42,status:'processando',resultados:[]})));
  await expect(noMarker.start({})).rejects.toMatchObject({code:'sandbox_unconfirmed'});
  await expect(noMarker.result(42,['PAN'])).rejects.toMatchObject({code:'sandbox_unconfirmed'});
 });

});
