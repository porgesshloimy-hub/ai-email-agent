"use server";

import { revalidatePath } from "next/cache";
import {
  createServerSupabase,
  createServiceSupabase,
} from "@/lib/supabase/server";
import type { AgentAction, PermissionLevel } from "@/types";
import { isValidModelSelection, type AIProvider } from "@/lib/agent/models";
import { isProviderConfigured } from "@/lib/agent/llm";

async function getAuthenticatedTenantId(): Promise<string> {
  const userSupabase = await createServerSupabase();

  const {
    data: { user },
    error: userError,
  } = await userSupabase.auth.getUser();

  if (userError || !user) {
    throw new Error("Not authenticated");
  }

  const { data: tenant, error: tenantError } = await userSupabase
    .from("tenants")
    .select("id")
    .eq("owner_user_id", user.id)
    .single();

  if (tenantError || !tenant) {
    throw new Error("Tenant not found");
  }

  return tenant.id;
}

export async function saveInstructions(formData: FormData) {
  const tenantId = await getAuthenticatedTenantId();

  const customInstructions = String(
    formData.get("customInstructions") ?? ""
  ).trim();

  const supabase = createServiceSupabase();

  const { error } = await supabase
    .from("agent_configs")
    .upsert(
      {
        tenant_id: tenantId,
        custom_instructions: customInstructions || null,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "tenant_id",
      }
    );

  if (error) {
    console.error("Failed to save agent instructions:", error);
    throw new Error("Failed to save agent instructions");
  }

  revalidatePath("/dashboard/agent");
}

/**
 * Save which AI provider/model powers this tenant's agent (both the
 * email pipeline in lib/agent/run.ts and the Google Chat handler in
 * lib/agent/chat.ts read this same selection — see
 * lib/agent/models.ts).
 */
export async function saveModelSelection(formData: FormData) {
  const tenantId = await getAuthenticatedTenantId();

  const provider = String(formData.get("aiProvider") ?? "");
  const model = String(formData.get("aiModel") ?? "");

  if (!isValidModelSelection(provider, model)) {
    throw new Error("Invalid model selection");
  }

  /**
   * Catalog membership alone isn't enough — this deployment's
   * environment might not actually have that provider's API key set
   * yet (see lib/agent/llm/index.ts's isProviderConfigured for the
   * production incident this guards against: a tenant selected
   * Claude Haiku 4.5 before ANTHROPIC_API_KEY existed in the
   * environment, and every email they received failed outright).
   * Reject the save here with a clear message instead of letting it
   * fail silently the next time an email comes in.
   */
  if (!isProviderConfigured(provider as AIProvider)) {
    throw new Error(
      "This model isn't available yet — it hasn't been fully configured on this deployment. Please choose a different model, or contact support."
    );
  }

  const supabase = createServiceSupabase();

  const { error } = await supabase
    .from("agent_configs")
    .upsert(
      {
        tenant_id: tenantId,
        ai_provider: provider,
        ai_model: model,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "tenant_id",
      }
    );

  if (error) {
    console.error("Failed to save model selection:", error);
    throw new Error("Failed to save model selection");
  }

  revalidatePath("/dashboard/agent");
}

export async function savePermission(formData: FormData) {
  const tenantId = await getAuthenticatedTenantId();

  const action = String(formData.get("action") ?? "");
  const level = String(formData.get("level") ?? "");

  const validActions: AgentAction[] = [
    "gmail.read",
    "gmail.draft",
    "gmail.send",
    "gmail.archive",
    "gmail.delete",
    "calendar.read",
    "calendar.write",
    "calendar.meet",
    "zoom.meet",
  ];

  const validLevels: PermissionLevel[] = [
    "denied",
    "approval_required",
    "allowed",
  ];

  if (!validActions.includes(action as AgentAction)) {
    throw new Error("Invalid agent action");
  }

  if (!validLevels.includes(level as PermissionLevel)) {
    throw new Error("Invalid permission level");
  }

  const supabase = createServiceSupabase();

  const { error } = await supabase
    .from("agent_permissions")
    .upsert(
      {
        tenant_id: tenantId,
        action,
        level,
      },
      {
        onConflict: "tenant_id,action",
      }
    );

  if (error) {
    console.error("Failed to save permission:", error);
    throw new Error("Failed to save permission");
  }

  revalidatePath("/dashboard/agent");
}

export async function addRule(formData: FormData) {
  const tenantId = await getAuthenticatedTenantId();

  const description = String(formData.get("description") ?? "").trim();

  if (!description) {
    throw new Error("Rule cannot be empty");
  }

  if (description.length > 500) {
    throw new Error("Rule is too long");
  }

  const supabase = createServiceSupabase();

  const { data: config, error: configError } = await supabase
    .from("agent_configs")
    .select("rules")
    .eq("tenant_id", tenantId)
    .single();

  if (configError && configError.code !== "PGRST116") {
    console.error("Failed to load agent config:", configError);
    throw new Error("Failed to load agent settings");
  }

  const existingRules = Array.isArray(config?.rules)
    ? config.rules
        .filter(
          (rule): rule is { description: string } =>
            typeof rule === "object" &&
            rule !== null &&
            typeof (rule as { description?: unknown }).description === "string"
        )
        .map((rule) => ({
          description: rule.description,
        }))
    : [];

  const updatedRules = [
    ...existingRules,
    {
      description,
    },
  ];

  const { error } = await supabase
    .from("agent_configs")
    .upsert(
      {
        tenant_id: tenantId,
        rules: updatedRules,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "tenant_id",
      }
    );

  if (error) {
    console.error("Failed to add rule:", error);
    throw new Error("Failed to add rule");
  }

  revalidatePath("/dashboard/agent");
}

export async function deleteRule(formData: FormData) {
  const tenantId = await getAuthenticatedTenantId();

  const index = Number(formData.get("index"));

  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Invalid rule");
  }

  const supabase = createServiceSupabase();

  const { data: config, error: configError } = await supabase
    .from("agent_configs")
    .select("rules")
    .eq("tenant_id", tenantId)
    .single();

  if (configError || !config) {
    throw new Error("Agent configuration not found");
  }

  const existingRules = Array.isArray(config.rules)
    ? config.rules
        .filter(
          (rule): rule is { description: string } =>
            typeof rule === "object" &&
            rule !== null &&
            typeof (rule as { description?: unknown }).description === "string"
        )
        .map((rule) => ({
          description: rule.description,
        }))
    : [];

  if (index >= existingRules.length) {
    throw new Error("Rule not found");
  }

  existingRules.splice(index, 1);

  const { error } = await supabase
    .from("agent_configs")
    .update({
      rules: existingRules,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId);

  if (error) {
    console.error("Failed to delete rule:", error);
    throw new Error("Failed to delete rule");
  }

  revalidatePath("/dashboard/agent");
}