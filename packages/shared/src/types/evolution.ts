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
  created_at: string;
  updated_at: string;
}
