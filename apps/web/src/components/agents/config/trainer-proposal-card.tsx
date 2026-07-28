"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { TrainerProposal } from "@aula-agente/shared";

interface TrainerProposalCardProps {
  proposal: TrainerProposal;
  onDecide: (proposalId: string, decision: "apply" | "reject") => Promise<void>;
  // Set when the last apply/reject for this proposal failed. Rendered so a
  // failed decision is never mistaken for a successful one.
  decisionError?: string;
}

export function TrainerProposalCard({ proposal, onDecide, decisionError }: TrainerProposalCardProps) {
  const [deciding, setDeciding] = useState(false);

  const handleDecide = async (decision: "apply" | "reject") => {
    setDeciding(true);
    try {
      await onDecide(proposal.id, decision);
    } finally {
      setDeciding(false);
    }
  };

  return (
    <div className="rounded-md border bg-background p-3 text-sm text-foreground">
      <p className="font-medium">{proposal.summary}</p>
      <p className="mt-1 text-muted-foreground">{proposal.rationale}</p>

      {proposal.conflicts.length > 0 && (
        <div className="mt-2 space-y-2 rounded-md bg-amber-50 p-2 dark:bg-amber-950">
          {proposal.conflicts.map((conflict, i) => (
            <div key={i}>
              <p className="text-amber-800 dark:text-amber-200">{conflict.description}</p>
              <ul className="ml-4 list-disc text-xs text-amber-700 dark:text-amber-300">
                {conflict.resolution_options.map((option, j) => (
                  <li key={j}>{option}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {proposal.diff.length > 0 && (
        <div className="mt-2 space-y-1 border-t pt-2">
          {proposal.diff.map((entry, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">{entry.field_path}:</span>
              <span className="line-through opacity-60">{JSON.stringify(entry.before)}</span>
              <span>→</span>
              <span className="font-medium">{JSON.stringify(entry.after)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Conflicts block applying, never rejecting: the server refuses to
          apply a conflicted proposal (409) but rejects one happily. Gating
          both buttons together left conflicted proposals — including the
          synthesised stage-2 failures — stuck at "proposed" forever, which
          also pinned the Trainer tab's pending badge above zero. */}
      {proposal.status === "proposed" && (
        <div className="mt-3 flex gap-2">
          {proposal.conflicts.length === 0 && (
            <Button size="sm" onClick={() => handleDecide("apply")} disabled={deciding}>
              Aplicar
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => handleDecide("reject")} disabled={deciding}>
            Rejeitar
          </Button>
        </div>
      )}

      {decisionError && (
        <p className="mt-2 rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">{decisionError}</p>
      )}

      {proposal.status === "applied" && (
        <Badge className="mt-3" variant="default">
          Aplicada
        </Badge>
      )}
      {proposal.status === "rejected" && (
        <Badge className="mt-3" variant="secondary">
          Rejeitada
        </Badge>
      )}
      {proposal.status !== "proposed" && proposal.status !== "applied" && proposal.status !== "rejected" && (
        <Badge className="mt-3" variant="outline">
          {proposal.status}
        </Badge>
      )}
    </div>
  );
}
