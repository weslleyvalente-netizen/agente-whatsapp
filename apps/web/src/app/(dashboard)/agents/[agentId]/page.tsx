"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function AgentPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/agents/${agentId}/editar`);
  }, [agentId, router]);

  return null;
}
