import {manualLiveSchema} from '@aula-agente/shared';
import {externalVehicleFromDraft,type VehicleDraft} from '../financing/vehicle';

export function manualVehicleFromDraft(input:{source:string;vehicleId:string;draft:VehicleDraft;condicao:string;placa:string}){
 const details={condicao:input.condicao,...(input.placa.trim()?{placa:input.placa}:{})};
 const external=input.source==='external'?externalVehicleFromDraft(input.draft):null;
 if(input.source==='external'&&!external)return null;
 const vehicle=input.source==='stock'
  ?{source:'stock',vehicleId:Number(input.vehicleId),...details}
  :{source:input.source,...external,...details};
 const result=manualLiveSchema.shape.vehicle.safeParse(vehicle);
 return result.success?result.data:null;
}
