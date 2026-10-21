import type {VehicleDraft} from './vehicle';
const field='mt-1 min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60';
export function ExternalVehicleFields({value,onChange,disabled}:{value:VehicleDraft;onChange:(value:VehicleDraft)=>void;disabled:boolean}){
  function update(key:keyof VehicleDraft,next:string){onChange({...value,[key]:next});}
  return <fieldset disabled={disabled} className="space-y-4 rounded-lg border p-4"><legend className="px-1 text-sm font-medium">Dados do veículo fora do estoque</legend>
    <p className="text-sm text-muted-foreground">Estes dados ficam somente na consulta. O veículo não será cadastrado no catálogo.</p>
    <label className="block text-sm font-medium">Tipo de veículo<select className={field} value={value.tipo} onChange={e=>update('tipo',e.target.value)}><option value="moto">Moto</option><option value="carro">Carro</option><option value="pesado">Veículo pesado</option></select></label>
    <label className="block text-sm font-medium">Marca<input className={field} required maxLength={100} value={value.marca} onChange={e=>update('marca',e.target.value)}/></label>
    <label className="block text-sm font-medium">Modelo<input className={field} required maxLength={200} value={value.modelo} onChange={e=>update('modelo',e.target.value)}/></label>
    <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-medium">Ano do modelo<input className={field} type="number" inputMode="numeric" min={1900} max={new Date().getUTCFullYear()+1} step="1" required value={value.ano} onInput={e=>update('ano',e.currentTarget.value)} onChange={e=>update('ano',e.target.value)}/></label>
    <label className="block text-sm font-medium">Valor de negociação (R$)<input className={field} type="number" inputMode="decimal" min="0.01" max="10000000" step="0.01" required value={value.preco} onInput={e=>update('preco',e.currentTarget.value)} onChange={e=>update('preco',e.target.value)}/></label></div>
    <label className="block text-sm font-medium">Versão (opcional)<input className={field} maxLength={200} value={value.versao} onChange={e=>update('versao',e.target.value)}/></label>
    <label className="block text-sm font-medium">Código FIPE (opcional)<input className={field} maxLength={8} placeholder="000000-0" value={value.codigo_fipe} onChange={e=>update('codigo_fipe',e.target.value)}/></label>
    <p className="text-sm text-muted-foreground">Versão e código FIPE são informados manualmente. Não é necessário informar valor ou data da tabela FIPE.</p>
  </fieldset>;
}
