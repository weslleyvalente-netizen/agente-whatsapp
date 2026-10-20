// Local one-shot test: synthetic data only, no CRM database and no WhatsApp.
import { CredProSandboxClient, CredProSandboxError } from '../packages/database/dist/financing/credpro-sandbox.js';

function hiddenKey(){
  if(!process.stdin.isTTY || !process.stdin.setRawMode)throw Error('interactive_terminal_required');
  process.stdout.write('Chave de TESTE CredPro (entrada oculta; apenas cpk_test_): ');
  return new Promise((resolve,reject)=>{
    let key='';
    const finish=(error)=>{
      process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');
      if(error){key='';reject(Error('cancelled'));}else{const value=key;key='';resolve(value);}
    };
    const onData=chunk=>{
      const text=chunk.toString('utf8').replace(/\x1b\[(?:200|201)~/g,'');
      for(const c of text){
        if(c==='\x03'||c==='\x04'){finish(true);return;}
        if(c==='\r'||c==='\n'){finish(false);return;}
        if(c==='\x7f'||c==='\b')key=key.slice(0,-1);
        else if(c>=' '&&c<='~')key+=c;
        if(key.length>512){finish(true);return;}
      }
    };
    process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',onData);
  });
}
async function main(){
  const scenario=process.argv[2]||'rejected';
  if(!['approved','rejected','mixed'].includes(scenario))throw Error('invalid_scenario');
  console.log('Teste isolado SANDBOX: somente dados fictícios, destino https://cred-pro.com/v1.');
  console.log('Nenhum dado de cliente ou credencial de banco é utilizado. A chave não será salva.');
  let key=process.env.CREDPRO_SANDBOX_KEY||await hiddenKey();
  const client=new CredProSandboxClient({key});key='';
  const id=await client.start(scenario,['PAN','C6']);
  console.log(`Sandbox confirmado. Consulta de teste: ${id}. Aguardando resultados...`);
  for(let i=0;i<8;i++){
    const result=await client.result(id);
    if(result.state==='completed'){
      console.log(JSON.stringify({sandbox:true,consultationId:result.consultationId,scenario,results:result.results},null,2));
      return;
    }
  }
  console.error(`Consulta ${id} ainda pendente. Não será criada outra automaticamente; confira o histórico de testes.`);
  process.exitCode=2;
}
main().catch(error=>{
  const code=error instanceof CredProSandboxError?error.code:'test_not_completed';
  console.error(`Teste não concluído (${code}). Nenhum erro bruto ou credencial foi registrado.`);
  console.error('O POST não será repetido automaticamente. Confira o histórico sandbox antes de repetir o teste.');
  process.exitCode=1;
});
