import { NextResponse } from "next/server";
import {
  createServerSupabase,
  createServiceSupabase,
} from "@/lib/supabase/server";
import {
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
} from "@/lib/agent/models";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Identify the currently logged-in user.
    const userSupabase = await createServerSupabase();

    const {
      data: { user },
      error: userError,
    } = await userSupabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    // Find the tenant owned by this user.
    const { data: tenant, error: tenantError } = await userSupabase
      .from("tenants")
      .select("id")
      .eq("owner_user_id", user.id)
      .single();

    if (tenantError || !tenant) {
      return NextResponse.json(
        { error: "Tenant not found" },
        { status: 404 }
      );
    }

    const supabase = createServiceSupabase();

    // Load the agent configuration.
    const { data: config, error: configError } = await supabase
      .from("agent_configs")
      .select("custom_instructions, rules, ai_provider, ai_model")
      .eq("tenant_id", tenant.id)
      .maybeSingle();

    if (configError) {
      console.error("Failed to load agent config:", configError);

      return NextResponse.json(
        { error: "Failed to load agent settings" },
        { status: 500 }
      );
    }

    // Load this tenant's permissions.
    const { data: permissions, error: permissionsError } = await supabase
      .from("agent_permissions")
      .select("action, level")
      .eq("tenant_id", tenant.id)
      .order("action", { ascending: true });

    if (permissionsError) {
      console.error("Failed to load agent permissions:", permissionsError);

      return NextResponse.json(
        { error: "Failed to load agent permissions" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      customInstructions: config?.custom_instructions ?? "",
      rules: Array.isArray(config?.rules) ? config.rules : [],
      permissions: permissions ?? [],
      aiProvider: config?.ai_provider ?? DEFAULT_AI_PROVIDER,
      aiModel: config?.ai_model ?? DEFAULT_AI_MODEL,
    });
  } catch (error) {
    console.error("Unexpected error loading agent settings:", error);

    return NextResponse.json(
      { error: "Failed to load agent settings" },
      { status: 500 }
    );
  }
}