/**
 * ------------------------------------------------------------
 * Persona types
 * ------------------------------------------------------------
 *
 * An agent persona (agent_personas, migration 010) is mostly configuration
 * sitting on top of infrastructure that's identical across all personas:
 * the same permission engine, memory system, content-safety checks, and
 * grounding guard. A persona differs from another by which tools/
 * connections it's allowed to touch and what its system prompt says —
 * not by new pipeline code.
 *
 * Every tenant is seeded (migration 010) with exactly one persona named
 * "Assistant", audience "customer" — this is what run.ts/chat.ts resolve
 * today. Adding "Bookkeeper" later should mean inserting a new row, not
 * writing new pipeline code.
 */

export type PersonaAudience = "customer" | "owner" | "both";

export interface AgentPersona {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  audience: PersonaAudience;
  allowedToolCategories: string[];
  allowedConnectionCategories: string[];
  /**
   * Permission overrides can only NARROW what the tenant's real,
   * connection-checked permissions already allow (lib/agent/permissions.ts)
   * — never widen them. Keys match the same capability names used
   * elsewhere (e.g. "gmail.send", "calendar.write", "zoom.meet").
   * A value here forces that capability down to the given level for this
   * persona specifically, regardless of what the tenant's real
   * configured/connected level is.
   */
  permissionOverrides: Record<string, "denied" | "approval_required" | "allowed">;
  active: boolean;
}

/**
 * Raw shape as stored in agent_personas — snake_case columns, jsonb
 * fields not yet parsed/typed.
 */
export interface AgentPersonaRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  audience: PersonaAudience;
  allowed_tool_categories: unknown;
  allowed_connection_categories: unknown;
  permission_overrides: unknown;
  active: boolean;
}
