import type {PendingReference} from './pending';
type Input={opportunityId:string;vehicleId:number;evidence:string;expiresAt:string;banks:string[];allowRequery:boolean};
type Api=(path:string,options:RequestInit)=>Promise<{id:string;request?:{id:string}|null}>;
type Journal={pending?:PendingReference;save:(value:PendingReference)=>void;clear:()=>void};
/** A journal stores references only. Recovering a page reconciles the original key before any POST. */
export function createMockSubmission(input:Input,api:Api,uuid:()=>string=()=>crypto.randomUUID(),journal?:Journal){
  const draft={...input,banks:[...input.banks]},key=journal?.pending?.key??uuid();
  let consentId=journal?.pending?.consentId,result:{id:string}|undefined,inFlight:Promise<{id:string}>|undefined,cancelled=false,reconcile=!!journal?.pending;
  const vehicleId=journal?.pending?.vehicleId??draft.vehicleId;
  const check=()=>{if(cancelled)throw new Error('Seleção alterada. Prepare uma nova consulta.');};
  return {
    cancel(){cancelled=true;},
    run():Promise<{id:string}>{
      if(cancelled)return Promise.reject(new Error('Seleção alterada. Prepare uma nova consulta.'));
      if(result)return Promise.resolve(result);
      if(inFlight)return inFlight;
      inFlight=(async()=>{
        if(reconcile){
          const found=await api(`/opportunities/${draft.opportunityId}/financing/requests/${key}`,{method:'GET'});check();
          if(found.request){result=found.request;journal?.clear();return result;}
          reconcile=false;
        }
        if(!consentId){
          const consent=await api(`/opportunities/${draft.opportunityId}/financing/consents`,{method:'POST',body:JSON.stringify({evidence:draft.evidence,expires_at:draft.expiresAt,banks:draft.banks,allow_requery:draft.allowRequery})});
          consentId=consent.id;
        }
        check();
        // If storage is unavailable, stop before POST rather than lose the recovery reference.
        journal?.save({key,consentId,vehicleId});
        result=await api(`/opportunities/${draft.opportunityId}/financing/requests`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({consent_id:consentId,vehicle_id:vehicleId})});
        journal?.clear();return result;
      })().finally(()=>{inFlight=undefined;});
      return inFlight;
    },
  };
}
