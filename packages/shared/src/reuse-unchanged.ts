/**
 * Mantém a MESMA referência de objeto para itens que não mudaram entre duas buscas (comparação por conteúdo, chave = id).
 * Evita re-renderizar centenas de cards a cada atualização automática quando quase nada mudou.
 */
export function reuseUnchanged<T extends { id: string }>(previous: T[], next: T[]): T[] {
  if (!previous.length) return next;
  const old = new Map(previous.map(item => [item.id, item]));
  let allSame = previous.length === next.length;
  const merged = next.map((item, i) => {
    const before = old.get(item.id);
    const same = before !== undefined && (before === item || JSON.stringify(before) === JSON.stringify(item));
    if (!same || previous[i] !== before) allSame = false;
    return same ? before : item;
  });
  return allSame ? previous : merged;
}
