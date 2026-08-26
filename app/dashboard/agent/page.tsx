"use client";

import { useEffect, useRef, useState } from "react";
import {
  addRule,
  deleteRule,
  saveInstructions,
  saveModelSelection,
  savePermission,
} from "./actions";
import {
  MODEL_OPTIONS_IN_DISPLAY_ORDER,
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_MODEL,
  type AIProvider,
} from "@/lib/agent/models";
import { GmailIcon, CalendarIcon, ZoomIcon } from "@/lib/integrations/icons";

type PermissionLevel =
  | "denied"
  | "approval_required"
  | "allowed";

type KnowledgeDocument = {
  id: string;
  file_name: string;
  storage_path: string;
  uploaded_at: string;
  chunk_count: number;
};

type KnowledgeChunk = {
  id: string;
  content: string;
};

type KnowledgeDetails = {
  document: KnowledgeDocument;
  chunks: KnowledgeChunk[];
};

type Permission = {
  action: string;
  level: PermissionLevel;
};

type Rule = {
  description: string;
};

const EMAIL_ACTIONS = [
  {
    key: "gmail.read",
    label: "Read & search email",
    description:
      "Allow the agent to read incoming emails and search your mailbox.",
  },
  {
    key: "gmail.draft",
    label: "Create email drafts",
    description:
      "Allow the agent to prepare replies in Gmail without sending them.",
  },
  {
    key: "gmail.send",
    label: "Send email",
    description:
      "Allow the agent to send emails to customers automatically.",
  },
  {
    key: "gmail.archive",
    label: "Archive email",
    description:
      "Allow the agent to archive emails after processing them.",
  },
  {
    key: "gmail.delete",
    label: "Delete email",
    description:
      "Allow the agent to permanently delete emails.",
  },
];

const CALENDAR_ACTIONS = [
  {
    key: "calendar.read",
    label: "Read calendar & availability",
    description:
      "Allow the agent to see your calendar and check available times.",
  },
  {
    key: "calendar.write",
    label: "Create & modify events",
    description:
      "Allow the agent to schedule or modify calendar events.",
  },
  {
    key: "calendar.meet",
    label: "Create Google Meet meetings",
    description:
      "Allow the agent to create calendar events with a Google Meet video meeting.",
  },
];

const ZOOM_ACTIONS = [
  {
    key: "zoom.meet",
    label: "Create Zoom meetings",
    description:
      "Allow the agent to create Zoom meetings on your behalf. When set to approval required, the agent will propose a meeting for you to confirm instead of creating it directly.",
  },
];

/**
 * PermissionBadge was removed as part of the compact row redesign —
 * PermissionSelect's own option text ("Automatic"/"Approval required"/
 * "Never") already communicates the level, so the separate badge row
 * underneath each item was redundant vertical space. See PermissionRow
 * below for the new compact layout.
 */

function PermissionSelect({
  action,
  level,
  onSaved,
  onError,
}: {
  action: string;
  level: PermissionLevel;
  onSaved: (action: string, level: PermissionLevel) => void;
  onError: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [selectedLevel, setSelectedLevel] =
    useState<PermissionLevel>(level);

  useEffect(() => {
    setSelectedLevel(level);
  }, [level]);

  async function handleChange(
    event: React.ChangeEvent<HTMLSelectElement>
  ) {
    const newLevel =
      event.target.value as PermissionLevel;

    const previousLevel = selectedLevel;

    setSelectedLevel(newLevel);
    setSaving(true);

    try {
      const formData = new FormData();

      formData.append("action", action);
      formData.append("level", newLevel);

      await savePermission(formData);

      onSaved(action, newLevel);
    } catch (error) {
      setSelectedLevel(previousLevel);

      onError(
        error instanceof Error
          ? error.message
          : "Failed to save permission."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <select
      name="level"
      value={selectedLevel}
      onChange={handleChange}
      disabled={saving}
      style={{
        flexShrink: 0,
        minWidth: 160,
        padding: "7px 30px 7px 10px",
        border: "1px solid #d4d4d8",
        borderRadius: 8,
        background: saving ? "#f4f4f5" : "#fff",
        fontSize: 12.5,
        fontWeight: 500,
        color: "#18181b",
        cursor: saving ? "wait" : "pointer",
        opacity: saving ? 0.7 : 1,
      }}
    >
      <option value="denied">Never</option>
      <option value="approval_required">
        Approval required
      </option>
      <option value="allowed">Automatic</option>
    </select>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#71717a",
          marginBottom: 6,
        }}
      >
        {eyebrow}
      </div>

      <h2
        style={{
          margin: 0,
          fontSize: 21,
          lineHeight: 1.3,
          color: "#18181b",
          letterSpacing: "-0.02em",
        }}
      >
        {title}
      </h2>

      <p
        style={{
          margin: "7px 0 0",
          color: "#71717a",
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        {description}
      </p>
    </div>
  );
}

function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 760,
          maxHeight: "85vh",
          background: "#fff",
          borderRadius: 16,
          boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * ------------------------------------------------------------
 * Toast notifications
 * ------------------------------------------------------------
 *
 * Replaces the previous single `message` banner, which rendered at
 * the very top of the page (right under the header) — if the user had
 * scrolled down (e.g. to the Rules or Knowledge section, common on
 * this long page) a "Permission saved"/"Model updated" confirmation
 * could render entirely off-screen above the viewport, effectively
 * invisible.
 *
 * Toasts instead render fixed to the bottom of the viewport (not the
 * page — position: fixed, so scroll position never matters), stacked
 * bottom-up, wide-but-short, and self-dismiss after a few seconds.
 * `zIndex: 2000` keeps them above the existing Modal (zIndex 1000) and
 * everything else on the page.
 */

type ToastTone = "success" | "error" | "info";

type ToastItem = {
  id: number;
  text: string;
  tone: ToastTone;
};

const TOAST_DURATION_MS = 3500;

const TOAST_TONE_STYLES: Record<
  ToastTone,
  { background: string; border: string; color: string }
> = {
  success: {
    background: "#f0fdf4",
    border: "#bbf7d0",
    color: "#166534",
  },
  error: {
    background: "#fef2f2",
    border: "#fecaca",
    color: "#b91c1c",
  },
  info: {
    background: "#18181b",
    border: "#27272a",
    color: "#fafafa",
  },
};

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        bottom: 22,
        transform: "translateX(-50%)",
        zIndex: 2000,
        display: "flex",
        flexDirection: "column-reverse",
        gap: 8,
        width: "min(92vw, 460px)",
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => {
        const tone = TOAST_TONE_STYLES[toast.tone];

        return (
          <div
            key={toast.id}
            onClick={() => onDismiss(toast.id)}
            role="status"
            style={{
              pointerEvents: "auto",
              cursor: "pointer",
              padding: "12px 16px",
              borderRadius: 12,
              background: tone.background,
              border: `1px solid ${tone.border}`,
              color: tone.color,
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.4,
              boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
              animation: "toast-in 0.18s ease-out",
            }}
          >
            {toast.text}
          </div>
        );
      })}
    </div>
  );
}

/**
 * ------------------------------------------------------------
 * Connection-gated permission rows
 * ------------------------------------------------------------
 *
 * A permission for an integration that isn't actually connected is
 * meaningless to change — the backend already enforces this (see
 * lib/agent/permissions.ts's resolveCalendarWriteCapability/
 * canReadCalendar/resolveZoomCapability, all of which require a real
 * connection before honoring any configured level at all). This
 * mirrors that same rule in the UI: a row for a disconnected
 * integration is faded and its control replaced with a static,
 * non-interactive "Not connected" pill linking to Settings, rather
 * than a dropdown the user could click that wouldn't actually do
 * anything different on the backend.
 */

function ConnectRequiredPill() {
  return (
    <a
      href="/dashboard/settings"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 12px",
        borderRadius: 999,
        border: "1px solid #e4e4e7",
        background: "#f4f4f5",
        color: "#71717a",
        fontSize: 12,
        fontWeight: 600,
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      Not connected
    </a>
  );
}

function PermissionRow({
  icon,
  action,
  level,
  connected,
  isFirst,
  onSaved,
  onError,
}: {
  icon: React.ReactNode;
  action: { key: string; label: string; description: string };
  level: PermissionLevel;
  connected: boolean;
  isFirst: boolean;
  onSaved: (action: string, level: PermissionLevel) => void;
  onError: (message: string) => void;
}) {
  return (
    <div
      title={action.description}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        borderTop: isFirst ? "none" : "1px solid #f0f0f1",
        opacity: connected ? 1 : 0.55,
      }}
    >
      <div style={{ flexShrink: 0, display: "flex" }}>{icon}</div>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            lineHeight: 1.3,
          }}
        >
          {action.label}
        </div>

        <div
          style={{
            fontSize: 11.5,
            color: "#a1a1aa",
            lineHeight: 1.35,
            marginTop: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {action.description}
        </div>
      </div>

      {connected ? (
        <PermissionSelect
          action={action.key}
          level={level}
          onSaved={onSaved}
          onError={onError}
        />
      ) : (
        <ConnectRequiredPill />
      )}
    </div>
  );
}

export default function AgentPage() {
  const [instructions, setInstructions] = useState("");

  const [rules, setRules] = useState<Rule[]>([]);

  const [permissions, setPermissions] =
    useState<Permission[]>([]);

  const [aiProvider, setAiProvider] =
    useState<AIProvider>(DEFAULT_AI_PROVIDER);

  const [aiModel, setAiModel] =
    useState<string>(DEFAULT_AI_MODEL);

  const [savingModel, setSavingModel] = useState(false);

  const [loading, setLoading] = useState(true);

  const [connections, setConnections] = useState({
    gmail: false,
    calendar: false,
    zoom: false,
  });

  const [newRule, setNewRule] = useState("");
  const [savingRule, setSavingRule] = useState(false);

  const [selectedRule, setSelectedRule] =
    useState<Rule | null>(null);

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);

  const [knowledgeLoading, setKnowledgeLoading] =
    useState(true);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [savingKnowledge, setSavingKnowledge] =
    useState(false);
  const [uploading, setUploading] = useState(false);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);

  function pushToast(text: string, tone: ToastTone = "info") {
    if (!text) return;

    const id = ++toastIdRef.current;

    setToasts((current) => [...current, { id, text, tone }]);

    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
  }

  function dismissToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  /*
   * Knowledge detail dialog state.
   */
  const [selectedKnowledge, setSelectedKnowledge] =
    useState<KnowledgeDocument | null>(null);

  const [knowledgeDetails, setKnowledgeDetails] =
    useState<KnowledgeDetails | null>(null);

  const [knowledgeDetailLoading, setKnowledgeDetailLoading] =
    useState(false);

  const [knowledgeDetailError, setKnowledgeDetailError] =
    useState("");

  useEffect(() => {
    async function loadAgent() {
      try {
        const response = await fetch("/api/agent/settings", {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(
            "Failed to load agent settings"
          );
        }

        const data = await response.json();

        setInstructions(data.customInstructions ?? "");
        setRules(data.rules ?? []);
        setPermissions(data.permissions ?? []);
        setAiProvider(data.aiProvider ?? DEFAULT_AI_PROVIDER);
        setAiModel(data.aiModel ?? DEFAULT_AI_MODEL);
        setConnections({
          gmail: Boolean(data.connections?.gmail),
          calendar: Boolean(data.connections?.calendar),
          zoom: Boolean(data.connections?.zoom),
        });
      } catch (error) {
        console.error(error);
        pushToast(
          error instanceof Error
            ? error.message
            : "Failed to load agent settings.",
          "error"
        );
      } finally {
        setLoading(false);
      }
    }

    loadAgent();
  }, []);

  async function loadKnowledge() {
    setKnowledgeLoading(true);

    try {
      const response = await fetch("/api/knowledge", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Failed to load knowledge");
      }

      const data = await response.json();

      setDocuments(data.documents ?? []);
    } catch (error) {
      console.error(error);

      pushToast(
        error instanceof Error ? error.message : "Failed to load knowledge.",
        "error"
      );
    } finally {
      setKnowledgeLoading(false);
    }
  }

  useEffect(() => {
    loadKnowledge();
  }, []);

  /*
   * These are the requested defaults for permissions
   * that don't yet have a row in the database.
   *
   * Existing saved permissions always take priority.
   *
   * zoom.meet defaults to "approval_required" (falls through to the
   * final return below) to match the current backend behavior of
   * always treating Zoom as propose-only until this is explicitly
   * changed.
   */
  function getPermission(
    action: string
  ): PermissionLevel {
    const existing = permissions.find(
      (permission) => permission.action === action
    );

    if (existing) {
      return existing.level;
    }

    if (
      action === "gmail.read" ||
      action === "gmail.draft" ||
      action === "calendar.read"
    ) {
      return "allowed";
    }

    return "approval_required";
  }

  function handlePermissionSaved(
    action: string,
    level: PermissionLevel
  ) {
    setPermissions((current) => {
      const existing = current.find(
        (permission) => permission.action === action
      );

      if (existing) {
        return current.map((permission) =>
          permission.action === action
            ? { ...permission, level }
            : permission
        );
      }

      return [
        ...current,
        {
          action,
          level,
        },
      ];
    });

    pushToast("Permission saved.", "success");
  }

  function handlePermissionError(message: string) {
    if (message) {
      pushToast(message, "error");
    }
  }

  async function handleInstructionsSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    const formData = new FormData(
      event.currentTarget
    );

    try {
      await saveInstructions(formData);

      pushToast("Instructions saved.", "success");
    } catch (error) {
      pushToast(
        error instanceof Error
          ? error.message
          : "Failed to save instructions.",
        "error"
      );
    }
  }

  async function handleModelChange(
    event: React.ChangeEvent<HTMLSelectElement>
  ) {
    const [nextProvider, nextModel] = event.target.value.split(
      "::"
    ) as [AIProvider, string];

    const previousProvider = aiProvider;
    const previousModel = aiModel;

    setAiProvider(nextProvider);
    setAiModel(nextModel);
    setSavingModel(true);

    try {
      const formData = new FormData();

      formData.append("aiProvider", nextProvider);
      formData.append("aiModel", nextModel);

      await saveModelSelection(formData);

      pushToast("Model updated.", "success");
    } catch (error) {
      setAiProvider(previousProvider);
      setAiModel(previousModel);

      pushToast(
        error instanceof Error
          ? error.message
          : "Failed to update model.",
        "error"
      );
    } finally {
      setSavingModel(false);
    }
  }

  async function handleAddRule() {
    if (!newRule.trim()) return;

    setSavingRule(true);

    try {
      const description = newRule.trim();

      const formData = new FormData();

      formData.append("description", description);

      await addRule(formData);

      setRules((current) => [
        ...current,
        {
          description,
        },
      ]);

      setNewRule("");

      pushToast("Rule added.", "success");
    } catch (error) {
      pushToast(
        error instanceof Error
          ? error.message
          : "Failed to add rule.",
        "error"
      );
    } finally {
      setSavingRule(false);
    }
  }

  async function handleDeleteRule(index: number) {
    try {
      const formData = new FormData();

      formData.append("index", String(index));

      await deleteRule(formData);

      setRules((current) =>
        current.filter(
          (_, ruleIndex) => ruleIndex !== index
        )
      );

      if (
        selectedRule &&
        rules[index]?.description ===
          selectedRule.description
      ) {
        setSelectedRule(null);
      }

      pushToast("Rule removed.", "success");
    } catch (error) {
      pushToast(
        error instanceof Error
          ? error.message
          : "Failed to remove rule.",
        "error"
      );
    }
  }

  async function handleManualKnowledge() {
    if (!title.trim() || !content.trim()) {
      pushToast(
        "Please enter both a title and the knowledge.",
        "error"
      );

      return;
    }

    setSavingKnowledge(true);

    try {
      const response = await fetch(
        "/api/knowledge/manual",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title,
            content,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Failed to save knowledge."
        );
      }

      setTitle("");
      setContent("");

      pushToast("Knowledge added successfully.", "success");

      await loadKnowledge();
    } catch (error) {
      pushToast(
        error instanceof Error
          ? error.message
          : "Failed to save knowledge.",
        "error"
      );
    } finally {
      setSavingKnowledge(false);
    }
  }

  async function handleUpload(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];

    if (!file) return;

    setUploading(true);

    try {
      const formData = new FormData();

      formData.append("file", file);

      const response = await fetch(
        "/api/knowledge/upload",
        {
          method: "POST",
          body: formData,
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Upload failed."
        );
      }

      pushToast(
        `Uploaded successfully. ${data.chunksCreated} knowledge chunks created.`,
        "success"
      );

      await loadKnowledge();

      event.target.value = "";
    } catch (error) {
      pushToast(
        error instanceof Error
          ? error.message
          : "Upload failed.",
        "error"
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteKnowledge(id: string) {
    if (
      !window.confirm(
        "Delete this knowledge? The agent will no longer use it."
      )
    ) {
      return;
    }

    try {
      const response = await fetch(
        `/api/knowledge/${id}`,
        {
          method: "DELETE",
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Failed to delete knowledge."
        );
      }

      if (selectedKnowledge?.id === id) {
        setSelectedKnowledge(null);
        setKnowledgeDetails(null);
        setKnowledgeDetailError("");
      }

      await loadKnowledge();

      pushToast("Knowledge deleted.", "success");
    } catch (error) {
      pushToast(
        error instanceof Error
          ? error.message
          : "Failed to delete knowledge.",
        "error"
      );
    }
  }

  /*
   * Open a knowledge item and load its stored chunks.
   */
  async function handleViewKnowledge(
    document: KnowledgeDocument
  ) {
    /*
     * Set the selected document BEFORE making the request.
     *
     * This guarantees that the dialog opens immediately
     * and shows its loading state while the API request runs.
     */
    setSelectedKnowledge(document);
    setKnowledgeDetails(null);
    setKnowledgeDetailError("");
    setKnowledgeDetailLoading(true);

    try {
      const response = await fetch(
        `/api/knowledge/${document.id}`,
        {
          method: "GET",
          cache: "no-store",
        }
      );

      const contentType =
        response.headers.get("content-type") || "";

      let data: any;

      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        await response.text();

        throw new Error(
          `Knowledge detail request returned an unexpected response (${response.status}).`
        );
      }

      if (!response.ok) {
        throw new Error(
          data.error ||
            "Failed to load knowledge details."
        );
      }

     setKnowledgeDetails({
  document: data.document,
  chunks: data.document?.chunks ?? [],
});
    } catch (error) {
      console.error(
        "Failed to load knowledge details:",
        error
      );

      setKnowledgeDetailError(
        error instanceof Error
          ? error.message
          : "Failed to load knowledge."
      );
    } finally {
      setKnowledgeDetailLoading(false);
    }
  }

  function closeKnowledgeDialog() {
    setSelectedKnowledge(null);
    setKnowledgeDetails(null);
    setKnowledgeDetailError("");
    setKnowledgeDetailLoading(false);
  }

  function closeRuleDialog() {
    setSelectedRule(null);
  }

  if (loading) {
    return (
      <main
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: "48px 24px",
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <div
          style={{
            height: 28,
            width: 220,
            background: "#f4f4f5",
            borderRadius: 8,
            marginBottom: 12,
          }}
        />

        <div
          style={{
            height: 16,
            width: 420,
            background: "#f4f4f5",
            borderRadius: 6,
          }}
        />
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#fafafa",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "#18181b",
      }}
    >
      <div
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: "48px 24px 80px",
        }}
      >
        <header style={{ marginBottom: 38 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "6px 10px",
              borderRadius: 999,
              background: "#f4f4f5",
              color: "#52525b",
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 14,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "#22c55e",
              }}
            />
            AI Agent
          </div>

          <h1
            style={{
              margin: 0,
              fontSize: 36,
              lineHeight: 1.15,
              letterSpacing: "-0.035em",
            }}
          >
            Agent setup
          </h1>

          <p
            style={{
              margin: "10px 0 0",
              maxWidth: 650,
              fontSize: 16,
              lineHeight: 1.6,
              color: "#71717a",
            }}
          >
            Teach your AI agent how your business works
            and decide exactly what it is allowed to do
            on your behalf.
          </p>
        </header>

        {/* Instructions */}
        <section
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 26,
            marginBottom: 20,
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.03)",
          }}
        >
          <SectionHeader
            eyebrow="Behavior"
            title="Instructions"
            description="Give the agent context about your business, how you want it to communicate, and how it should handle customers."
          />

          <form onSubmit={handleInstructionsSubmit}>
            <textarea
              name="customInstructions"
              value={instructions}
              onChange={(event) =>
                setInstructions(event.target.value)
              }
              rows={7}
              placeholder={`Example:

We are a plumbing company serving Brooklyn.

Answer straightforward pricing questions automatically. Be friendly and concise. If a customer asks for a refund or complains about a previous service, do not make a commitment without approval.`}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: 15,
                border: "1px solid #d4d4d8",
                borderRadius: 10,
                resize: "vertical",
                fontFamily: "inherit",
                fontSize: 14,
                lineHeight: 1.6,
                outline: "none",
              }}
            />

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: 12,
              }}
            >
              <button
                type="submit"
                style={{
                  border: 0,
                  borderRadius: 9,
                  padding: "10px 17px",
                  background: "#18181b",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Save instructions
              </button>
            </div>
          </form>
        </section>

        {/* AI model */}
        <section
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 26,
            marginBottom: 20,
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.03)",
          }}
        >
          <SectionHeader
            eyebrow="Behavior"
            title="AI model"
            description="Choose which AI model powers your agent. Faster, cheaper models are a good fit for routine email; more advanced models handle complex or nuanced conversations better."
          />

          <select
            value={`${aiProvider}::${aiModel}`}
            onChange={handleModelChange}
            disabled={savingModel}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "11px 13px",
              border: "1px solid #d4d4d8",
              borderRadius: 9,
              fontFamily: "inherit",
              fontSize: 14,
              fontWeight: 500,
              background: savingModel ? "#f4f4f5" : "#fff",
              color: "#18181b",
              cursor: savingModel ? "wait" : "pointer",
            }}
          >
            {MODEL_OPTIONS_IN_DISPLAY_ORDER.map((option) => (
              <option
                key={`${option.provider}::${option.id}`}
                value={`${option.provider}::${option.id}`}
              >
                {option.tier}
                {option.recommended ? " ⭐ Recommended" : ""} —{" "}
                {option.label}
              </option>
            ))}
          </select>

          {(() => {
            const selected = MODEL_OPTIONS_IN_DISPLAY_ORDER.find(
              (option) =>
                option.provider === aiProvider &&
                option.id === aiModel
            );

            if (!selected) {
              return null;
            }

            return (
              <div
                style={{
                  marginTop: 12,
                  padding: 13,
                  borderRadius: 10,
                  background: "#fafafa",
                  fontSize: 13,
                  lineHeight: 1.55,
                }}
              >
                <div
                  style={{
                    fontWeight: 700,
                    color: "#18181b",
                    marginBottom: 3,
                  }}
                >
                  {selected.tier}
                  {selected.recommended ? " ⭐ Recommended" : ""}
                </div>

                <div style={{ color: "#52525b" }}>
                  {selected.tierDescription}
                </div>
              </div>
            );
          })()}

          {savingModel && (
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: "#71717a",
              }}
            >
              Saving...
            </div>
          )}
        </section>

        {/* Email permissions */}
        <section
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 20,
            marginBottom: 14,
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.03)",
          }}
        >
          <SectionHeader
            eyebrow="Permissions"
            title="Email"
            description="Control exactly what the agent can do with your Gmail account."
          />

          <div
            style={{
              border: "1px solid #e4e4e7",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {EMAIL_ACTIONS.map((action, index) => (
              <PermissionRow
                key={action.key}
                icon={<GmailIcon size={20} />}
                action={action}
                level={getPermission(action.key)}
                connected={connections.gmail}
                isFirst={index === 0}
                onSaved={handlePermissionSaved}
                onError={handlePermissionError}
              />
            ))}
          </div>

          {!connections.gmail && (
            <div
              style={{
                marginTop: 10,
                padding: "9px 12px",
                borderRadius: 9,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Connect Gmail in{" "}
              <a href="/dashboard/settings" style={{ color: "#b91c1c", fontWeight: 600 }}>
                Settings
              </a>{" "}
              to enable these permissions.
            </div>
          )}

          <div
            style={{
              marginTop: 10,
              padding: 11,
              borderRadius: 10,
              background: "#fafafa",
              color: "#71717a",
              fontSize: 11.5,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "#52525b" }}>
              Approval required
            </strong>{" "}
            means the agent can prepare the action, but
            it cannot complete it until you approve it.
          </div>
        </section>

        {/* Calendar */}
        <section
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 20,
            marginBottom: 14,
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.03)",
          }}
        >
          <SectionHeader
            eyebrow="Permissions"
            title="Calendar"
            description="Choose whether your agent can view availability, manage calendar events, and create Google Meet meetings."
          />

          <div
            style={{
              border: "1px solid #e4e4e7",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {CALENDAR_ACTIONS.map((action, index) => (
              <PermissionRow
                key={action.key}
                icon={<CalendarIcon size={20} />}
                action={action}
                level={getPermission(action.key)}
                connected={connections.calendar}
                isFirst={index === 0}
                onSaved={handlePermissionSaved}
                onError={handlePermissionError}
              />
            ))}
          </div>

          {!connections.calendar && (
            <div
              style={{
                marginTop: 10,
                padding: "9px 12px",
                borderRadius: 9,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Grant Calendar access in{" "}
              <a href="/dashboard/settings" style={{ color: "#b91c1c", fontWeight: 600 }}>
                Settings
              </a>{" "}
              to enable these permissions.
            </div>
          )}

          <div
            style={{
              marginTop: 10,
              padding: 11,
              borderRadius: 10,
              background: "#fafafa",
              color: "#71717a",
              fontSize: 11.5,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "#52525b" }}>
              Google Meet
            </strong>{" "}
            controls whether the agent may add a Google
            Meet conference when creating a calendar event.
          </div>
        </section>

        {/* Zoom */}
        <section
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 20,
            marginBottom: 14,
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.03)",
          }}
        >
          <SectionHeader
            eyebrow="Permissions"
            title="Zoom"
            description="Choose whether your agent can create Zoom meetings directly or must ask for your approval first."
          />

          <div
            style={{
              border: "1px solid #e4e4e7",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {ZOOM_ACTIONS.map((action, index) => (
              <PermissionRow
                key={action.key}
                icon={<ZoomIcon size={20} />}
                action={action}
                level={getPermission(action.key)}
                connected={connections.zoom}
                isFirst={index === 0}
                onSaved={handlePermissionSaved}
                onError={handlePermissionError}
              />
            ))}
          </div>

          {!connections.zoom && (
            <div
              style={{
                marginTop: 10,
                padding: "9px 12px",
                borderRadius: 9,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Connect Zoom in{" "}
              <a href="/dashboard/settings" style={{ color: "#b91c1c", fontWeight: 600 }}>
                Settings
              </a>{" "}
              to enable this permission.
            </div>
          )}

          <div
            style={{
              marginTop: 10,
              padding: 11,
              borderRadius: 10,
              background: "#fafafa",
              color: "#71717a",
              fontSize: 11.5,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "#52525b" }}>
              Automatic
            </strong>{" "}
            lets the agent create Zoom meetings directly.{" "}
            <strong style={{ color: "#52525b" }}>
              Approval required
            </strong>{" "}
            has it propose a meeting for you to confirm first.
          </div>
        </section>

        {/* Rules */}
        <section
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 26,
            marginBottom: 20,
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.03)",
          }}
        >
          <SectionHeader
            eyebrow="Guardrails"
            title="Rules"
            description="Add specific situations where the agent should behave differently or ask for your approval."
          />

          {rules.length > 0 && (
            <div
              style={{
                display: "grid",
                gap: 9,
                marginBottom: 14,
              }}
            >
              {rules.map((rule, index) => (
                <div
                  key={`${rule.description}-${index}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 15,
                    padding: "13px 15px",
                    border: "1px solid #e4e4e7",
                    borderRadius: 10,
                    background: "#fafafa",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <span
                      style={{
                        marginTop: 5,
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: "#a1a1aa",
                        flexShrink: 0,
                      }}
                    />

                    <span
                      style={{
                        fontSize: 14,
                        lineHeight: 1.5,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {rule.description}
                    </span>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      flexShrink: 0,
                    }}
                  >
                    {/* Explicit View button */}
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedRule(rule)
                      }
                      style={{
                        border: 0,
                        background: "transparent",
                        color: "#18181b",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                        padding: "6px 8px",
                      }}
                    >
                      View
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleDeleteRule(index)
                      }
                      style={{
                        border: 0,
                        background: "transparent",
                        color: "#a1a1aa",
                        fontSize: 12,
                        cursor: "pointer",
                        padding: "6px 8px",
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: 9,
            }}
          >
            <input
              value={newRule}
              onChange={(event) =>
                setNewRule(event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAddRule();
                }
              }}
              placeholder="Example: Refund requests always require approval."
              style={{
                flex: 1,
                minWidth: 0,
                padding: "11px 13px",
                border: "1px solid #d4d4d8",
                borderRadius: 9,
                fontFamily: "inherit",
                fontSize: 14,
              }}
            />

            <button
              type="button"
              onClick={handleAddRule}
              disabled={
                savingRule || !newRule.trim()
              }
              style={{
                border: 0,
                borderRadius: 9,
                padding: "0 17px",
                background:
                  savingRule || !newRule.trim()
                    ? "#e4e4e7"
                    : "#18181b",
                color:
                  savingRule || !newRule.trim()
                    ? "#a1a1aa"
                    : "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor:
                  savingRule || !newRule.trim()
                    ? "default"
                    : "pointer",
              }}
            >
              {savingRule ? "Adding..." : "Add rule"}
            </button>
          </div>
        </section>

        {/* Knowledge */}
        <section
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 26,
            marginBottom: 20,
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.03)",
          }}
        >
          <SectionHeader
            eyebrow="Knowledge"
            title="Business knowledge"
            description="Give your agent the information it needs to answer customers accurately."
          />

          {/* Upload */}
          <div
            style={{
              padding: 20,
              border: "1px dashed #d4d4d8",
              borderRadius: 12,
              background: "#fafafa",
              marginBottom: 18,
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                marginBottom: 5,
              }}
            >
              Upload a document
            </div>

            <div
              style={{
                fontSize: 13,
                color: "#71717a",
                marginBottom: 14,
                lineHeight: 1.5,
              }}
            >
              Upload pricing, FAQs, policies, product
              information, or other business documents.
            </div>

            <input
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={handleUpload}
              disabled={uploading}
              style={{
                fontSize: 13,
              }}
            />

            {uploading && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 13,
                  color: "#71717a",
                }}
              >
                Uploading and indexing...
              </div>
            )}
          </div>

          {/* Manual knowledge */}
          <div
            style={{
              padding: 20,
              border: "1px solid #e4e4e7",
              borderRadius: 12,
              marginBottom: 20,
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                marginBottom: 5,
              }}
            >
              Add individual knowledge
            </div>

            <div
              style={{
                fontSize: 13,
                color: "#71717a",
                marginBottom: 15,
              }}
            >
              Add a specific fact, price, policy, or
              instruction.
            </div>

            <input
              value={title}
              onChange={(event) =>
                setTitle(event.target.value)
              }
              placeholder="Title — e.g. Emergency service pricing"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "11px 13px",
                border: "1px solid #d4d4d8",
                borderRadius: 9,
                fontFamily: "inherit",
                fontSize: 14,
                marginBottom: 10,
              }}
            />

            <textarea
              value={content}
              onChange={(event) =>
                setContent(event.target.value)
              }
              placeholder="Emergency plumbing service costs $250 after 6 PM."
              rows={4}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "11px 13px",
                border: "1px solid #d4d4d8",
                borderRadius: 9,
                resize: "vertical",
                fontFamily: "inherit",
                fontSize: 14,
                lineHeight: 1.5,
              }}
            />

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: 10,
              }}
            >
              <button
                type="button"
                onClick={handleManualKnowledge}
                disabled={
                  savingKnowledge ||
                  !title.trim() ||
                  !content.trim()
                }
                style={{
                  border: 0,
                  borderRadius: 9,
                  padding: "10px 16px",
                  background:
                    savingKnowledge ||
                    !title.trim() ||
                    !content.trim()
                      ? "#e4e4e7"
                      : "#18181b",
                  color:
                    savingKnowledge ||
                    !title.trim() ||
                    !content.trim()
                      ? "#a1a1aa"
                      : "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {savingKnowledge
                  ? "Saving..."
                  : "Add knowledge"}
              </button>
            </div>
          </div>

          {/* Existing knowledge */}
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#52525b",
                marginBottom: 10,
              }}
            >
              Your knowledge
            </div>

            {knowledgeLoading ? (
              <div
                style={{
                  padding: 20,
                  color: "#71717a",
                  fontSize: 13,
                }}
              >
                Loading knowledge...
              </div>
            ) : documents.length === 0 ? (
              <div
                style={{
                  padding: 20,
                  border: "1px solid #e4e4e7",
                  borderRadius: 10,
                  color: "#71717a",
                  fontSize: 13,
                  textAlign: "center",
                }}
              >
                No business knowledge has been added
                yet.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gap: 8,
                }}
              >
                {documents.map((document) => (
                  <div
                    key={document.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 15,
                      padding: "13px 15px",
                      border: "1px solid #e4e4e7",
                      borderRadius: 10,
                    }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {document.file_name}
                      </div>

                      <div
                        style={{
                          fontSize: 12,
                          color: "#a1a1aa",
                          marginTop: 4,
                        }}
                      >
                        {document.chunk_count} knowledge{" "}
                        {document.chunk_count === 1
                          ? "chunk"
                          : "chunks"}{" "}
                        ·{" "}
                        {new Date(
                          document.uploaded_at
                        ).toLocaleDateString()}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        flexShrink: 0,
                      }}
                    >
                      {/* Explicit View button */}
                      <button
                        type="button"
                        onClick={() =>
                          handleViewKnowledge(document)
                        }
                        style={{
                          border: 0,
                          background: "transparent",
                          color: "#18181b",
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: "pointer",
                          padding: "6px 8px",
                        }}
                      >
                        View
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          handleDeleteKnowledge(
                            document.id
                          )
                        }
                        style={{
                          border: 0,
                          background: "transparent",
                          color: "#71717a",
                          fontSize: 12,
                          cursor: "pointer",
                          padding: "6px 8px",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Footer explanation */}
        <div
          style={{
            textAlign: "center",
            color: "#a1a1aa",
            fontSize: 12,
            lineHeight: 1.6,
            padding: "10px 20px",
          }}
        >
          Your permissions are enforced by the
          application before the AI can perform an
          action. The AI cannot override these settings.
        </div>
      </div>

      {/* RULE DETAIL DIALOG */}
      {selectedRule && (
        <Modal onClose={closeRuleDialog}>
          <div
            style={{
              padding: "20px 22px",
              borderBottom: "1px solid #e4e4e7",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 15,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#71717a",
                  marginBottom: 5,
                }}
              >
                Agent rule
              </div>

              <h2
                style={{
                  margin: 0,
                  fontSize: 20,
                  letterSpacing: "-0.02em",
                }}
              >
                Rule details
              </h2>
            </div>

            <button
              type="button"
              onClick={closeRuleDialog}
              aria-label="Close"
              style={{
                border: 0,
                background: "#f4f4f5",
                width: 34,
                height: 34,
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 18,
                color: "#52525b",
              }}
            >
              ×
            </button>
          </div>

          <div
            style={{
              padding: 22,
              overflowY: "auto",
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: "#a1a1aa",
                textTransform: "uppercase",
                fontWeight: 700,
                letterSpacing: "0.06em",
                marginBottom: 9,
              }}
            >
              Rule
            </div>

            <div
              style={{
                padding: 18,
                border: "1px solid #e4e4e7",
                borderRadius: 10,
                background: "#fafafa",
                fontSize: 15,
                lineHeight: 1.7,
                color: "#27272a",
                whiteSpace: "pre-wrap",
              }}
            >
              {selectedRule.description}
            </div>
          </div>

          <div
            style={{
              padding: "14px 22px",
              borderTop: "1px solid #e4e4e7",
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              onClick={closeRuleDialog}
              style={{
                border: 0,
                borderRadius: 9,
                padding: "10px 16px",
                background: "#18181b",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      {/* KNOWLEDGE DETAIL DIALOG */}
      {selectedKnowledge && (
        <Modal
          onClose={() => {
            if (!knowledgeDetailLoading) {
              closeKnowledgeDialog();
            }
          }}
        >
          {/* Dialog header */}
          <div
            style={{
              padding: "20px 22px",
              borderBottom: "1px solid #e4e4e7",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 15,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#71717a",
                  marginBottom: 5,
                }}
              >
                Business knowledge
              </div>

              <h2
                style={{
                  margin: 0,
                  fontSize: 20,
                  letterSpacing: "-0.02em",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedKnowledge.file_name}
              </h2>
            </div>

            <button
              type="button"
              onClick={closeKnowledgeDialog}
              disabled={knowledgeDetailLoading}
              aria-label="Close"
              style={{
                border: 0,
                background: "#f4f4f5",
                width: 34,
                height: 34,
                borderRadius: 8,
                cursor: knowledgeDetailLoading
                  ? "default"
                  : "pointer",
                fontSize: 18,
                color: "#52525b",
                flexShrink: 0,
                opacity: knowledgeDetailLoading
                  ? 0.5
                  : 1,
              }}
            >
              ×
            </button>
          </div>

          {/* Dialog content */}
          <div
            style={{
              padding: 22,
              overflowY: "auto",
            }}
          >
            {knowledgeDetailLoading ? (
              <div
                style={{
                  padding: "55px 20px",
                  textAlign: "center",
                  color: "#71717a",
                  fontSize: 14,
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    border: "3px solid #e4e4e7",
                    borderTop:
                      "3px solid #18181b",
                    borderRadius: "50%",
                    margin: "0 auto 14px",
                    animation:
                      "knowledge-spin 0.8s linear infinite",
                  }}
                />

                Loading knowledge...
              </div>
            ) : knowledgeDetailError ? (
              <div
                style={{
                  padding: 16,
                  borderRadius: 10,
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#b91c1c",
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                <strong>
                  Could not load this knowledge.
                </strong>

                <div style={{ marginTop: 5 }}>
                  {knowledgeDetailError}
                </div>

                <button
                  type="button"
                  onClick={() =>
                    handleViewKnowledge(
                      selectedKnowledge
                    )
                  }
                  style={{
                    marginTop: 14,
                    border: 0,
                    borderRadius: 8,
                    padding: "9px 13px",
                    background: "#18181b",
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Try again
                </button>
              </div>
            ) : knowledgeDetails ? (
              <>
                {/* Metadata */}
                <div
                  style={{
                    display: "flex",
                    gap: 24,
                    marginBottom: 20,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#a1a1aa",
                        textTransform: "uppercase",
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                      }}
                    >
                      File
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        marginTop: 4,
                      }}
                    >
                      {
                        knowledgeDetails.document
                          .file_name
                      }
                    </div>
                  </div>

                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#a1a1aa",
                        textTransform: "uppercase",
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                      }}
                    >
                      Added
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        marginTop: 4,
                      }}
                    >
                      {new Date(
                        knowledgeDetails.document.uploaded_at
                      ).toLocaleString()}
                    </div>
                  </div>

                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#a1a1aa",
                        textTransform: "uppercase",
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                      }}
                    >
                      Chunks
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        marginTop: 4,
                      }}
                    >
                      {
                        knowledgeDetails.chunks
                          .length
                      }
                    </div>
                  </div>
                </div>

                {/* Stored content */}
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#52525b",
                    marginBottom: 10,
                  }}
                >
                  Stored knowledge
                </div>

                <div
                  style={{
                    border: "1px solid #e4e4e7",
                    borderRadius: 10,
                    overflow: "hidden",
                  }}
                >
                  {knowledgeDetails.chunks.length ===
                  0 ? (
                    <div
                      style={{
                        padding: 20,
                        color: "#71717a",
                        fontSize: 13,
                      }}
                    >
                      No readable text was stored for
                      this knowledge item.
                    </div>
                  ) : (
                    knowledgeDetails.chunks.map(
                      (chunk, index) => (
                        <div
                          key={chunk.id}
                          style={{
                            padding: "16px 18px",
                            borderTop:
                              index === 0
                                ? "none"
                                : "1px solid #f0f0f1",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: "#a1a1aa",
                              marginBottom: 8,
                            }}
                          >
                            CHUNK {index + 1}
                          </div>

                          <div
                            style={{
                              fontSize: 14,
                              lineHeight: 1.65,
                              whiteSpace: "pre-wrap",
                              color: "#27272a",
                            }}
                          >
                            {chunk.content}
                          </div>
                        </div>
                      )
                    )
                  )}
                </div>
              </>
            ) : null}
          </div>

          {/* Dialog footer */}
          <div
            style={{
              padding: "14px 22px",
              borderTop: "1px solid #e4e4e7",
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              onClick={closeKnowledgeDialog}
              disabled={knowledgeDetailLoading}
              style={{
                border: 0,
                borderRadius: 9,
                padding: "10px 16px",
                background:
                  knowledgeDetailLoading
                    ? "#e4e4e7"
                    : "#18181b",
                color:
                  knowledgeDetailLoading
                    ? "#a1a1aa"
                    : "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor:
                  knowledgeDetailLoading
                    ? "default"
                    : "pointer",
              }}
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      <style jsx global>{`
        @keyframes knowledge-spin {
          from {
            transform: rotate(0deg);
          }

          to {
            transform: rotate(360deg);
          }
        }

        @keyframes toast-in {
          from {
            opacity: 0;
            transform: translateY(8px);
          }

          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </main>
  );
}