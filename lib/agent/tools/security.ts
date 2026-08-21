/**
 * Thrown when a tool handler detects that the model attempted an action
 * the current permission configuration does not allow. This should be
 * structurally impossible (the model is never given a tool it isn't
 * permitted to use), so if it happens it indicates a bug in tool
 * exposure rather than an ordinary external-API failure. Unlike ordinary
 * tool failures (a Gmail/Calendar API error, a transient DB error), this
 * is never reported back to the model as "try something else" — it
 * aborts the whole run so it surfaces loudly instead of being quietly
 * routed around.
 *
 * Moved out of lib/agent/run.ts (where it used to be declared inline)
 * so individual tool modules under lib/agent/tools/ and run.ts's catch
 * block can share the exact same class for `instanceof` checks.
 */
export class SecurityViolationError extends Error {}
