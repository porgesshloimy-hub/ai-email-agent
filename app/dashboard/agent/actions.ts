"use server";

import { revalidatePath } from "next/cache";
import {
  createServerSupabase,
  createServiceSupabase,
} from "@/lib/supabase/server";
import type { AgentAction, PermissionLevel } from "@/types";

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