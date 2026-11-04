/** Responsável inicial do formulário de tarefa: o da tarefa editada ou, em tarefa nova, o próprio usuário quando pedido. */
export function initialAssigneeValue(
  task: { assignee_type?: string | null; assignee_id?: string | null } | null,
  selfUserId?: string | null,
): string {
  if (task) return task.assignee_type === "human" ? `human:${task.assignee_id}` : task.assignee_type === "ai" ? "ai" : "none";
  return selfUserId ? `human:${selfUserId}` : "none";
}
