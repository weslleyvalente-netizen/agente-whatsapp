// Only documented CredPro fields cross the provider boundary. Neither price nor
// a FIPE code is a FIPE valuation; neither is sent as fipe_value.
export function providerPayload(application:any,credentials:any,mode:'sandbox'|'live'){
 const v=application.vehicle,c=application.customer;
 return {cpf:c.cpf,celular:c.phone,data_nascimento:c.birthDate,tipo_veiculo:v.tipo,possui_cnh:c.hasDriverLicense,
  veiculo_marca:v.marca,veiculo_modelo:providerModel(v.modelo,v.versao),veiculo_ano:v.ano,
  ...(v.placa?{placa:v.placa}:{}),
  ...(application.desiredCredit?{valor_desejado:application.desiredCredit}:{}),
  bancos:Object.fromEntries(application.banks.map((bank:string)=>{const b=mode==='sandbox'?{username:'x',password:'x'}:credentials.banks.find((b:any)=>b.bank===bank);if(!b)throw Error('bank');return [bank,{usuario:b.username,senha:b.password}];}))};
}
function providerModel(model:string,version?:string){
 if(!version?.trim())return model;
 const normalize=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toUpperCase();
 const m=normalize(model),v=normalize(version);
 if((' '+m+' ').includes(' '+v+' '))return model;
 if(v.startsWith(m+' '))return version.trim();
 const modelWords=m.split(' '),versionWords=v.split(' '),originalWords=version.trim().split(/\s+/);
 for(let size=Math.min(modelWords.length,versionWords.length);size>0;size--){
  if(modelWords.slice(-size).join(' ')===versionWords.slice(0,size).join(' '))return `${model} ${originalWords.slice(size).join(' ')}`;
 }
 return `${model} ${version.trim()}`;
}
export function sandboxApplication(scenario:'approved'|'rejected'|'mixed',banks:string[]){
 // Official synthetic CPFs select outcomes; no real customer fields accepted.
 const cpf=scenario==='approved'?'11111111119':scenario==='rejected'?'11111111110':'11111111111';
 return {customer:{name:'Cliente fictício sandbox',cpf,phone:'11999999999',birthDate:'1990-01-01',hasDriverLicense:true},vehicle:{source:'external',tipo:'moto',marca:'Honda',modelo:'CG 160',ano:2024,preco:18000},banks};
}
export function publicCase(row:any,application:any){
 const v=application.vehicle,c=application.customer;
 return {id:row.id,mode:row.mode,state:row.state,createdAt:row.created_at,banks:row.banks,results:row.revoked_at?[]:row.results,
  customer:{name:c.name,cpf:'***.***.***-'+String(c.cpf).slice(-2)},vehicle:{source:v.source,marca:v.marca,modelo:providerModel(v.modelo,v.versao),ano:v.ano,preco:v.preco,condicao:v.condicao??null,hasPlate:!!v.placa},desiredCredit:application.desiredCredit??null,consentExpiresAt:row.consent_expires_at,
  errorCode:row.error_code,providerId:row.provider_id??null};
}
