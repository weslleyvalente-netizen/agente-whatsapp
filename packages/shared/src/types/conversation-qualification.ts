export type AttendanceType = "financing" | "consortium" | "cash" | "workshop";
export type QualificationUrgency = "immediate" | "this_week" | "flexible";

export interface ConversationQualification {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string;

  attendance_type: AttendanceType | null;
  product_interest: string | null;
  product_model: string | null;
  usage_purpose: string | null;
  city: string | null;
  urgency: QualificationUrgency | null;

  sale_amount: number | null;
  credit_amount: number | null;
  down_payment_amount: number | null;
  bid_amount: number | null;
  target_installment_amount: number | null;
  term_months: number | null;

  cpf_encrypted: string | null;
  cpf_hash: string | null;
  birth_date: string | null;
  has_driver_license: boolean | null;
  driver_license_category: string | null;

  summary: string | null;
  next_action: string | null;
  commercial_notes: string | null;

  human_locked_fields: string[];

  created_at: string;
  updated_at: string;
}

export type ConversationQualificationEventType = "field_updated" | "cpf_replaced";

export interface ConversationQualificationEvent {
  id: string;
  organization_id: string;
  conversation_qualification_id: string;
  event_type: ConversationQualificationEventType;
  changed_fields: Record<string, unknown> | null;
  changed_by_type: "human" | "ai";
  changed_by_id: string | null;
  created_at: string;
}

// The subset of ConversationQualification's own fields that a caller may
// write in one call — never id/organization_id/conversation_id/contact_id
// (identity of the row itself) or human_locked_fields (computed internally).
export interface ConversationQualificationWriteFields {
  attendance_type?: AttendanceType | null;
  product_interest?: string | null;
  product_model?: string | null;
  usage_purpose?: string | null;
  city?: string | null;
  urgency?: QualificationUrgency | null;
  sale_amount?: number | null;
  credit_amount?: number | null;
  down_payment_amount?: number | null;
  bid_amount?: number | null;
  target_installment_amount?: number | null;
  term_months?: number | null;
  summary?: string | null;
  next_action?: string | null;
  commercial_notes?: string | null;
}

export interface ConversationQualificationIdentityWrite {
  cpf?: string | null;
  birth_date?: string | null;
  has_driver_license?: boolean | null;
  driver_license_category?: string | null;
}
