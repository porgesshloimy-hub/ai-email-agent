export type PermissionLevel = "denied" | "approval_required" | "allowed";

export type GmailAction = "gmail.read" | "gmail.draft" | "gmail.send" | "gmail.archive" | "gmail.delete";

export interface AgentPermission {
  action: GmailAction;
  level: PermissionLevel;
}

export interface AgentRule {
  description: string;
}

export interface AgentConfig {
  tenantId: string;
  customInstructions: string | null;
  rules: AgentRule[];
}

export interface Tenant {
  id: string;
  ownerUserId: string;
  businessName: string;
  businessDescription: string | null;
  phoneNumber: string | null;
}

export type EmailActionStatus = "processed" | "pending_approval" | "approved" | "rejected" | "sent";

export interface EmailAction {
  id: string;
  tenantId: string;
  gmailThreadId: string;
  gmailMessageId: string | null;
  actionType: "draft_reply" | "archive" | "escalate";
  status: EmailActionStatus;
  draftContent: string | null;
  reasoning: string | null;
}
