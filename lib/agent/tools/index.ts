import { createDraftTool } from "./create-draft";
import { sendReplyTool } from "./send-reply";
import {
  createCalendarEventEmailTool,
  createCalendarEventChatTool,
} from "./create-calendar-event";
import {
  proposeCalendarEventWriteTool,
  proposeCalendarEventProposeOnlyTool,
} from "./propose-calendar-event";
import { createZoomMeetingTool } from "./create-zoom-meeting";
import {
  proposeZoomMeetingWriteTool,
  proposeZoomMeetingProposeOnlyTool,
} from "./propose-zoom-meeting";
import { checkPendingApprovalsTool } from "./check-pending-approvals";
import { requestAdditionalCapabilityTool } from "./request-additional-capability";
import { noActionRequiredTool } from "./no-action-required";

import type { ToolContext, ToolDefinition, ToolSurface } from "./types";

export * from "./types";
export { SecurityViolationError } from "./security";

/**
 * Every tool definition known to either surface. Some tool *names*
 * appear more than once here (create_calendar_event, propose_zoom_meeting,
 * propose_calendar_event) because the two surfaces — or two permission
 * states within the same surface — historically used different schemas
 * for "the same" tool name. See the DISCREPANCY comments in each tool's
 * module for details. `getToolsForSurface` below, combined with each
 * entry's own `isAvailable`, guarantees at most one definition per name
 * is ever actually offered to the model for a given surface + context.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  createDraftTool,
  sendReplyTool,
  createCalendarEventEmailTool,
  createCalendarEventChatTool,
  proposeCalendarEventWriteTool,
  proposeCalendarEventProposeOnlyTool,
  createZoomMeetingTool,
  proposeZoomMeetingWriteTool,
  proposeZoomMeetingProposeOnlyTool,
  checkPendingApprovalsTool,
  requestAdditionalCapabilityTool,
  noActionRequiredTool,
];

/**
 * Tool definitions available for the given surface and context, in
 * `ALL_TOOLS` order (matching the push order of the old
 * buildToolDefinitions()/buildChatToolDefinitions() functions, which
 * matters because that order becomes the order the model sees the
 * tools in).
 */
export function getToolsForSurface(
  surface: ToolSurface,
  context: ToolContext
): ToolDefinition[] {
  return ALL_TOOLS.filter(
    (tool) => tool.surfaces.includes(surface) && tool.isAvailable(context)
  );
}

/**
 * Find the single tool definition to dispatch a given tool name to for
 * a surface + context. Since permission states are mutually exclusive,
 * at most one definition with a given name is ever available for a
 * given surface + context at once — this returns that one (or
 * undefined if the model called a tool name that isn't currently
 * offered).
 */
export function findToolForSurface(
  name: string,
  surface: ToolSurface,
  context: ToolContext
): ToolDefinition | undefined {
  return getToolsForSurface(surface, context).find(
    (tool) => tool.name === name
  );
}
