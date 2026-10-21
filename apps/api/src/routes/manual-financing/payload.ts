// Only documented CredPro fields cross the provider boundary. Neither price nor
// a FIPE code is a FIPE valuation; neither is sent as fipe_value.
export function providerPayload(application:any,credentials:any,mode:'sandbox'|'live'){
 const v=application.vehicle,c=application.customer;
 return {cpf:c.cpf,celular:c.phone,data_nascimento:c.birthDate,tipo_veiculo:v.tipo,possui_cnh:c.hasDriverLicense,
  veiculo_marca:v.marca,veiculo_modelo:v.modelo,veiculo_ano:v.ano,
  ...(application.desiredCredit?{valor_desejado:application.desiredCredit}:{}),
  bancos:Object.fromEntries(application.banks.map((bank:string)=>{const b=mode==='sandbox'?{username:'x',password:'x'}:credentials.banks.find((b:any)=>b.bank===bank);if(!b)throw Error('bank');return [bank,{usuario:b.username,senha:b.password}];}))};
}
export function sandboxApplication(scenario:'approved'|'rejected'|'mixed',banks:string[]){
 // Official synthetic CPFs select outcomes; no real customer fields accepted.
 const cpf=scenario==='approved'?'11111111119':scenario==='rejected'?'11111111110':'11111111111';
 return {customer:{name:'Cliente fictício sandbox',cpf,phone:'11999999999',birthDate:'1990-01-01',hasDriverLicense:true},vehicle:{source:'external',tipo:'moto',marca:'Honda',modelo:'CG 160',ano:2024,preco:18000},banks};
}
export function publicCase(row:any,application:any){
 const v=application.vehicle,c=application.customer;
 return {id:row.id,mode:row.mode,state:row.state,createdAt:row.created_at,banks:row.banks,results:row.revoked_at?[]:row.results,
  customer:{name:c.name,cpf:'***.***.***-'+String(c.cpf).slice(-2)},vehicle:{source:v.source,marca:v.marca,modelo:v.modelo,ano:v.ano,preco:v.preco},desiredCredit:application.desiredCredit??null,consentExpiresAt:row.consent_expires_at,
  errorCode:row.error_code,providerId:row.provider_id??null};
}
