import { deriveAvailableCapabilities } from "@/lib/agent/router";

import type { ToolContext, ToolDefinition } from "./types";

/**
 * Escape hatch for the capability pre-router (lib/agent/router/).
 *
 * The router (wired into lib/agent/run.ts) may narrow the tools handed
 * to the model for a given email down to a subset of what's actually
 * permission-available, based on cheap keyword/classifier signals. Those
 * signals are not perfect. This tool is how the model recovers when it
 * turns out it needed a capability the router left out — e.g. the
 * router saw no calendar keywords, but partway through handling the
 * email it becomes clear a meeting actually needs to be scheduled.
 *
 * IMPORTANT — this tool grants nothing by itself. Its execute() below
 * does not touch the tenant's permissions or the router's decision; it
 * only re-runs the exact same deterministic, permission-derived
 * availability check the router itself used
 * (deriveAvailableCapabilities, built directly from the same
 * ToolPermissions the router and every other tool's isAvailable()
 * already trust) and reports whether the requested capability is
 * *actually* permitted:
 *
 *  - If the capability is genuinely permission-available but was simply
 *    excluded by routing, this tells the model so — and
 *    lib/agent/run.ts's agent loop (see the special-cased handling of
 *    this tool's name there) is what actually adds that capability's
 *    tools to the `tools` array for the next loop iteration. This tool
 *    never mutates that array itself; it only returns a signal for
 *    run.ts to act on.
 *  - If the capability is not permission-available at all, this simply
 *    reports that back, same as if the tool had never been offered —
 *    the model is expected to fall back to create_draft/escalation as
 *    normal, exactly as if this tool didn't exist.
 *
 * This means the model requesting an arbitrary/made-up capability name,
 * or a capability the tenant has genuinely not enabled, can never result
 * in that capability actually being granted — the check below is the
 * same one the router already trusts, re-run fresh, not the model's own
 * claim.
 */
export interface RequestAdditionalCapabilityResult {
  success: boolean;
  /** True only when the requested capability is genuinely permission-available (was merely router-excluded). */
  granted: boolean;
  capability: string;
  message: string;
}

export const requestAdditionalCapabilityTool: ToolDefinition = {
  name: "request_additional_capability",

  description:
    "Request access to a capability (e.g. \"calendar\" or \"zoom\") that is not currently offered to you, if you determine partway through handling this email that you actually need it. This does not grant anything by itself — it checks whether the capability is genuinely permitted for this business and, if so, makes its tools available to you for your next step. If it isn't permitted, you'll be told so and should fall back to create_draft or explain that this requires the account holder's own review.",

  parameters: {
    type: "object",

    properties: {
      capability: {
        type: "string",
        description:
          "The capability you need, e.g. \"calendar\" or \"zoom\".",
      },

      reason: {
        type: "string",
        description:
          "Brief explanation of why this email actually requires that capability.",
      },
    },

    required: ["capability", "reason"],
  },

  surfaces: ["email"],

  /**
   * Not a real domain capability — this tool is about *requesting*
   * capabilities, so it isn't gated by the capability filter itself.
   * lib/agent/run.ts decides per-run whether to actually include it in
   * the offered tool list (only when something permission-available was
   * in fact routed out — see the module comment above), independent of
   * this flag.
   */
  capability: "meta",

  isAvailable: () => true,

  terminal: false,

  async execute(
    args: Record<string, any>,
    context: ToolContext
  ): Promise<RequestAdditionalCapabilityResult> {
    const requestedCapability =
      typeof args.capability === "string" ? args.capability.trim() : "";

    if (!requestedCapability) {
      return {
        success: false,
        granted: false,
        capability: requestedCapability,
        message:
          "No capability was specified. Reassess the task using the tools you already have.",
      };
    }

    const available = deriveAvailableCapabilities(context.permissions);
    const granted = available.includes(requestedCapability);

    return {
      success: true,
      granted,
      capability: requestedCapability,
      message: granted
        ? `The "${requestedCapability}" capability is permitted for this business and has been added to your available tools. Reassess the task now that it's available — do not repeat this request.`
        : `The "${requestedCapability}" capability is not permitted for this business. Do not attempt it and do not ask again — fall back to create_draft, send_reply, or explain that this requires the account holder's own review, per the available permissions.`,
    };
  },
};
