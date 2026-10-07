export function describeSla(dueAt: string | null | undefined, now: Date = new Date()): { label: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const diffMin = Math.ceil((Date.parse(dueAt) - now.getTime()) / 60_000);
  if (diffMin > 0) return { label: `${diffMin} min`, overdue: false };
  return { label: `Vencido há ${Math.floor(-diffMin)} min`, overdue: true };
}
