export type OwnerChip = { kind: "owner" | "none"; label: string };

/** Etiqueta do vendedor no card do funil. Null quando o AssignmentBadge já mostra o vendedor ou o negócio não está aberto. */
export function ownerChip(input: { status: string; owner_id?: string | null; owner_name?: string | null; hasAssignment: boolean }): OwnerChip | null {
  if (input.hasAssignment || input.status !== "open") return null;
  // Campo ausente = a API não enriqueceu a linha (ex.: rodízio desligado): não mostra nada, de forma consistente.
  if (input.owner_name === undefined) return null;
  if (!input.owner_id) return { kind: "none", label: "Sem vendedor" };
  const name = input.owner_name?.trim();
  return name ? { kind: "owner", label: name } : null;
}
