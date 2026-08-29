import { createServiceSupabase } from "@/lib/supabase/server";
import type { AgentPersona, AgentPersonaRow, PersonaAudience } from "@/lib/agent/personas/types";

/**
 * Fallback used only if a tenant somehow has zero personas (shouldn't
 * happen after migration 010's seed step, but a tenant created between
 * this code shipping and some future signup-flow update that inserts a
 * persona automatically could hit this gap). Fails toward the same
 * behavior the system had before personas existed at all — a single
 * customer-facing assistant with no capability narrowing — rather than
 * failing the email/chat pipeline outright.
 */
function defaultPersona(tenantId: string, audience: PersonaAudience): AgentPersona {
  return {
    id: `synthetic-default-${tenantId}`,
    tenantId,
    name: "Assistant",
    description: "Synthetic fallback persona — no agent_personas row found for this tenant.",
    systemPrompt: "",
    audience,
    allowedToolCategories: [],
    allowedConnectionCategories: [],
    permissionOverrides: {},
    active: true,
  };
}

function parseJsonbArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function parsePermissionOverrides(
  value: unknown
): Record<string, "denied" | "approval_required" | "allowed"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, "denied" | "approval_required" | "allowed"> = {};

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === "denied" || raw === "approval_required" || raw === "allowed") {
      result[key] = raw;
    }
  }

  return result;
}

function rowToPersona(row: AgentPersonaRow): AgentPersona {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    audience: row.audience,
    allowedToolCategories: parseJsonbArray(row.allowed_tool_categories),
    allowedConnectionCategories: parseJsonbArray(row.allowed_connection_categories),
    permissionOverrides: parsePermissionOverrides(row.permission_overrides),
    active: row.active,
  };
}

/**
 * Resolves which persona should handle a given tenant + audience.
 *
 * For a single-personality setup this always returns the one seeded
 * "Assistant" row. Once multiple personas exist for the same audience,
 * this is the one place that decides which one is "the" active persona
 * for that audience — currently "most recently created active match,"
 * which is a placeholder policy. Once routing between multiple personas
 * of the same audience is actually needed (e.g. choosing between
 * Secretary and Bookkeeper for an owner message), this function is where
 * that routing logic belongs — callers should not have to know how the
 * choice is made.
 */
export async function resolvePersona(
  tenantId: string,
  audience: PersonaAudience
): Promise<AgentPersona> {
  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("agent_personas")
    .select(
      "id, tenant_id, name, description, system_prompt, audience, allowed_tool_categories, allowed_connection_categories, permission_overrides, active"
    )
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .or(`audience.eq.${audience},audience.eq.both`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("PERSONA RESOLUTION FAILED — falling back to synthetic default:", {
      tenantId,
      audience,
      error,
    });
    return defaultPersona(tenantId, audience);
  }

  if (!data) {
    console.error(
      "NO PERSONA FOUND FOR TENANT — this should not happen after migration 010's " +
        "seed step; falling back to synthetic default. Check whether this tenant " +
        "predates the seed or was created without the normal signup flow.",
      { tenantId, audience }
    );
    return defaultPersona(tenantId, audience);
  }

  return rowToPersona(data as AgentPersonaRow);
}
