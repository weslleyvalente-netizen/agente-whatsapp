export type ExternalVehicle={tipo:'moto'|'carro'|'pesado';marca:string;modelo:string;ano:number;preco:number;versao?:string;codigo_fipe?:string};
export type VehicleDraft={tipo:string;marca:string;modelo:string;ano:string;preco:string;versao:string;codigo_fipe:string};
export const emptyVehicleDraft:VehicleDraft={tipo:'moto',marca:'',modelo:'',ano:'',preco:'',versao:'',codigo_fipe:''};
export function externalVehicleFromDraft(draft:VehicleDraft):ExternalVehicle|null{
  const tipo=draft.tipo,marca=draft.marca.trim(),modelo=draft.modelo.trim(),ano=Number(draft.ano),preco=Number(draft.preco),versao=draft.versao.trim(),code=draft.codigo_fipe.trim();
  if(!['moto','carro','pesado'].includes(tipo)||!marca||marca.length>100||!modelo||modelo.length>200||!Number.isInteger(ano)||ano<1900||ano>new Date().getUTCFullYear()+1||!Number.isFinite(preco)||preco<=0||preco>10_000_000||versao.length>200||(code&&!/^\d{6}-\d$/.test(code)))return null;
  return {tipo:tipo as ExternalVehicle['tipo'],marca,modelo,ano,preco,...(versao?{versao}:{}),...(code?{codigo_fipe:code}:{})};
}
