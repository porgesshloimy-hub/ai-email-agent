"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { normalizePhoneNumber } from "@/lib/sms/twilio";
import { isValidTimezone } from "@/lib/timezones";

async function getTenantId() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id")
    .eq("owner_user_id", user?.id)
    .single();

  return { supabase, tenantId: tenant?.id };
}

/**
 * The business's own operating timezone — see lib/agent/date-context.ts
 * for what this actually controls (what the agent considers "today").
 * Validated against the runtime's own Intl implementation
 * (lib/timezones.ts's isValidTimezone) rather than trusting whatever a
 * <select> happened to submit — the option list is a UI convenience,
 * not the source of truth for what's a real IANA zone.
 */
export async function saveTimezone(formData: FormData) {
  const timezone = String(formData.get("timezone") ?? "").trim();

  if (!isValidTimezone(timezone)) {
    throw new Error(`"${timezone}" is not a recognized timezone.`);
  }

  const { supabase, tenantId } = await getTenantId();
  if (!tenantId) return;

  const { error } = await supabase
    .from("tenants")
    .update({ timezone })
    .eq("id", tenantId);

  if (error) {
    throw new Error(`Failed to save timezone: ${error.message}`);
  }

  revalidatePath("/dashboard/settings");
}

/**
 * The owner's phone numbers for texting the agent.
 *
 *   primaryPhone     where the agent texts you first (reminders,
 *                    scheduled-action results, approval requests).
 *   additionalPhone  a second phone that may also text the agent.
 *
 * Both are normalized to E.164 (what Twilio reports as an inbound
 * message's From), and either may be left blank to clear it. A number
 * already belonging to ANOTHER tenant is rejected: an inbound text is
 * matched to a tenant by its number alone, so two accounts sharing one
 * would make that match ambiguous. That check needs the service client
 * — RLS (correctly) hides other tenants' rows from the user client.
 */
export async function savePhoneNumbers(formData: FormData) {
  const primaryInput = String(formData.get("primaryPhone") ?? "").trim();
  const additionalInput = String(formData.get("additionalPhone") ?? "").trim();

  const primary = primaryInput ? normalizePhoneNumber(primaryInput) : null;
  const additional = additionalInput ? normalizePhoneNumber(additionalInput) : null;

  if (primaryInput && !primary) {
    throw new Error(
      `"${primaryInput}" isn't a valid phone number. Use a US number like (555) 123-4567 or international format starting with +.`
    );
  }

  if (additionalInput && !additional) {
    throw new Error(
      `"${additionalInput}" isn't a valid phone number. Use a US number like (555) 123-4567 or international format starting with +.`
    );
  }

  if (primary && additional && primary === additional) {
    throw new Error("The second number is the same as the first — leave it blank or enter a different phone.");
  }

  const { supabase, tenantId } = await getTenantId();
  if (!tenantId) return;

  const service = createServiceSupabase();

  for (const number of [primary, additional]) {
    if (!number) continue;

    const { data: takenPrimary } = await service
      .from("tenants")
      .select("id")
      .eq("phone_number", number)
      .neq("id", tenantId)
      .limit(1);

    const { data: takenAdditional } = await service
      .from("tenants")
      .select("id")
      .contains("additional_phone_numbers", [number])
      .neq("id", tenantId)
      .limit(1);

    if ((takenPrimary?.length ?? 0) > 0 || (takenAdditional?.length ?? 0) > 0) {
      throw new Error(`${number} is already linked to another account.`);
    }
  }

  const { error } = await supabase
    .from("tenants")
    .update({
      phone_number: primary,
      additional_phone_numbers: additional ? [additional] : [],
    })
    .eq("id", tenantId);

  if (error) {
    throw new Error(`Failed to save phone numbers: ${error.message}`);
  }

  revalidatePath("/dashboard/settings");
}

export async function disconnectGoogle() {
  const { supabase, tenantId } = await getTenantId();
  if (!tenantId) return;

  await supabase.from("gmail_connections").delete().eq("tenant_id", tenantId);
  revalidatePath("/settings");
}

export async function disconnectZoom() {
  const { supabase, tenantId } = await getTenantId();
  if (!tenantId) return;

  await supabase.from("zoom_connections").delete().eq("tenant_id", tenantId);
  revalidatePath("/settings");
}