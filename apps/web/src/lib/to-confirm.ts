// Aba "A confirmar" do funil (decisão do dono 25/11): cards criados sem produto identificado (operation_is_default) saem da aba de
// venda de veículos e ficam numa aba própria até o vendedor confirmar o produto. Só interface: usa o campo operation_is_default.
import { FUNNEL_STAGES, type Operation } from "@aula-agente/shared";

export const TO_CONFIRM = "to_confirm" as const;
export type FunnelTab = Operation | typeof TO_CONFIRM;
type Card = { operation: Operation; operation_is_default?: boolean | null; stage: string };

/** Aba do card: indefinido vai para "A confirmar"; nunca conta em Venda de veículos enquanto estiver assim. */
export const tabOf = (o: Card): FunnelTab => (o.operation_is_default ? TO_CONFIRM : o.operation);
export const filterForTab = <T extends Card>(list: T[], tab: FunnelTab): T[] => list.filter((o) => tabOf(o) === tab);
/** Contadores por aba (cada card conta uma vez; a soma é o total geral de oportunidades). */
export function countsByTab(list: Card[]): Map<FunnelTab, number> {
  const m = new Map<FunnelTab, number>();
  for (const o of list) m.set(tabOf(o), (m.get(tabOf(o)) ?? 0) + 1);
  return m;
}
/**
 * Confirmar o produto: a API grava a operação (e tira a marca). Trocar de funil volta para a primeira etapa; se a etapa atual existe no
 * funil de destino e não é a primeira, ela é reaplicada em seguida (histórico registra as duas mudanças; o responsável não muda).
 */
export function confirmPlan(o: Card, target: Operation): { operation: Operation; restoreStage: string | null } {
  const stages = FUNNEL_STAGES[target] as readonly string[];
  const restoreStage = o.stage !== stages[0] && stages.includes(o.stage) ? o.stage : null;
  return { operation: target, restoreStage };
}
