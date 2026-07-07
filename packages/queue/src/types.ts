export interface ProcessMessageJobData {
  conversationId: string;
  messageId: string;
  agentId: string;
  organizationId: string;
}

export interface SendMessageJobData {
  conversationId: string;
  messageId: string;
  instanceId: string;
  phone: string;
  content: string;
  organizationId: string;
}

export interface ProcessDocumentJobData {
  documentId: string;
  organizationId: string;
  agentId: string;
}

export interface TakeoverTimeoutJobData {
  // no data needed — scans all expired takeovers
}
