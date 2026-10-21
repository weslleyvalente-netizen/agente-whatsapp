export type PendingReference={key:string;consentId:string;vehicleId:number|null};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function pendingStore(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,userId:string,organizationId:string,opportunityId:string){
  const name=`financing-pending:${userId}:${organizationId}:${opportunityId}`;
  return {
    load():PendingReference|null{
      const raw=storage.getItem(name);if(!raw)return null;
      const value=JSON.parse(raw) as PendingReference;
      if(!value||!uuid.test(value.key)||!uuid.test(value.consentId)||(value.vehicleId!==null&&(!Number.isSafeInteger(value.vehicleId)||value.vehicleId<=0)))throw new Error('Referência de consulta inválida. Solicite a verificação do histórico.');
      return {key:value.key,consentId:value.consentId,vehicleId:value.vehicleId};
    },
    save(value:PendingReference){storage.setItem(name,JSON.stringify({key:value.key,consentId:value.consentId,vehicleId:value.vehicleId}));},
    clear(){storage.removeItem(name);},
  };
}
