export type InstanceStatus = "connected" | "disconnected" | "connecting";

export interface EvolutionInstance {
  id: string;
  organization_id: string;
  instance_name: string;
  instance_id: string;
  status: InstanceStatus;
  phone_number: string | null;
  webhook_url: string | null;
  active_agent_id: string | null;
  /** Provedor de WhatsApp ativo; ausente (antes da migração 20261120140000) = "evolution". */
  provider?: "evolution" | "uazapi";
  /** Token da instância na UAZAPI, cifrado (whatsapp/instance-token.ts no agent-runtime). Nunca vai para a web. */
  provider_token_encrypted?: string | null;
  created_at: string;
  updated_at: string;
}
