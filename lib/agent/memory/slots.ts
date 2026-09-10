/**
 * Static registry of slot fields — the single source of truth for what's
 * a structured "slot" (a specific, named, overwrite-in-place fact) versus
 * a freeform note (unstructured, accumulates, similarity-deduped), and
 * which slots are "consequential": ones that feed a real tool call
 * (shipping/contact info an action might actually use) and therefore
 * (a) are written with verified: false until confirmed, and (b) are
 * always pinned — see lib/agent/memory/pinned.ts — rather than depending
 * on the agent remembering to search for them.
 *
 * Add a new slot here whenever the extractor (extractor.ts) or the owner-
 * intent parser (owner-intent.ts, a later phase) needs to recognize a new
 * named fact. Keys are stored verbatim in agent_memories.slot_key.
 */
export interface MemorySlotDefinition {
  /** Whether this slot's value could feed a real tool call (an address used on a shipment, a phone number used to call/text). Consequential slots are pinned and require confirmation before being used in an action — never before being recorded. */
  consequential: boolean;
  /** Short human-readable label, for dashboard display (Phase 7.1). */
  label: string;
}

export const MEMORY_SLOTS = {
  shipping_address: {
    consequential: true,
    label: "Shipping address",
  },
  billing_address: {
    consequential: true,
    label: "Billing address",
  },
  phone_number: {
    consequential: true,
    label: "Phone number",
  },
  preferred_contact_method: {
    consequential: false,
    label: "Preferred contact method",
  },
  preferred_name: {
    consequential: false,
    label: "Preferred name",
  },
  preferred_language: {
    consequential: false,
    label: "Preferred language",
  },
  company_name: {
    consequential: false,
    label: "Company name",
  },
} as const satisfies Record<string, MemorySlotDefinition>;

export type MemorySlotKey = keyof typeof MEMORY_SLOTS;

export function isKnownSlotKey(key: string): key is MemorySlotKey {
  return Object.prototype.hasOwnProperty.call(MEMORY_SLOTS, key);
}

export function isConsequentialSlot(key: string): boolean {
  return isKnownSlotKey(key) && MEMORY_SLOTS[key].consequential;
}

/** All slot keys flagged consequential — used by pinned.ts to fetch exactly these, no more. */
export const CONSEQUENTIAL_SLOT_KEYS: MemorySlotKey[] = (
  Object.keys(MEMORY_SLOTS) as MemorySlotKey[]
).filter((key) => MEMORY_SLOTS[key].consequential);
