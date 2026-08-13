"use client";

import { useEffect, useState } from "react";
import {
  addRule,
  deleteRule,
  saveInstructions,
  savePermission,
} from "./actions";

type PermissionLevel = "denied" | "approval_required" | "allowed";

type Permission = {
  action: string;
  level: PermissionLevel;
};

type Rule = {
  description: string;
};

type KnowledgeDocument = {
  id: string;
  file_name: string;
  storage_path: string;
  uploaded_at: string;
  chunk_count: number;
};

const EMAIL_ACTIONS = [
  {
    key: "gmail.read",
    label: "Read & search email",
    description:
      "Read incoming messages and search your Gmail mailbox when needed.",
  },
  {
    key: "gmail.draft",
    label: "Create email drafts",
    description:
      "Prepare replies and other emails in Gmail without sending them.",
  },
  {
    key: "gmail.send",
    label: "Send email",
    description:
      "Send emails to customers automatically when permitted.",
  },
  {
    key: "gmail.archive",
    label: "Archive email",
    description:
      "Archive emails after the agent has finished processing them.",
  },
  {
    key: "gmail.delete",
    label: "Delete email",
    description:
      "Permanently delete emails. Consider requiring approval for this action.",
  },
];

const CALENDAR_ACTIONS = [
  {
    key: "calendar.read",
    label: "Read calendar & availability",
    description:
      "Check your calendar and determine available times.",
  },
  {
    key: "calendar.write",
    label: "Create & modify events",
    description:
      "Schedule, update, or modify calendar events.",
  },
];

function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section
      style={{
        background: "#ffffff",
        border: "1px solid #e4e4e7",
        borderRadius: 18,
        boxShadow: "0 2px 8px rgba(0,0,0,0.025)",
        ...style,
      }}
    >
      {children}
    </section>
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
          letterSpacing: "0.09em",
          textTransform: "uppercase",
          color: "#71717a",
          marginBottom: 7,
        }}
      >
        {eyebrow}
      </div>

      <h2
        style={{
          margin: 0,
          fontSize: 21,
          lineHeight: 1.3,
          letterSpacing: "-0.025em",
          color: "#18181b",
        }}
      >
        {title}
      </h2>

      <p
        style={{
          margin: "7px 0 0",
          maxWidth: 700,
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

function PermissionBadge({
  level,
}: {
  level: PermissionLevel;
}) {
  if (level === "allowed") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 9px",
          borderRadius: 999,
          background: "#ecfdf3",
          color: "#027a48",
          fontSize: 11,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        <span>✓</span>
        Automatic
      </span>
    );
  }

  if (level === "approval_required") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 9px",
          borderRadius: 999,
          background: "#fff7ed",
          color: "#c2410c",
          fontSize: 11,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        <span>●</span>
        Approval required
      </span>
    );
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 9px",
        borderRadius: 999,
        background: "#f4f4f5",
        color: "#52525b",
        fontSize: 11,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      <span>×</span>
      Never
    </span>
  );
}

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
  const [selectedLevel, setSelectedLevel] =
    useState<PermissionLevel>(level);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelectedLevel(level);
  }, [level]);

  async function handleChange(
    event: React.ChangeEvent<HTMLSelectElement>
  ) {
    const newLevel = event.target.value as PermissionLevel;
    const previousLevel = selectedLevel;

    setSelectedLevel(newLevel);
    setSaving(true);
    onError("");

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
      value={selectedLevel}
      onChange={handleChange}
      disabled={saving}
      style={{
        width: 190,
        maxWidth: "100%",
        padding: "9px 34px 9px 11px",
        border: "1px solid #d4d4d8",
        borderRadius: 9,
        background: saving ? "#f4f4f5" : "#fff",
        color: "#18181b",
        fontSize: 13,
        fontWeight: 600,
        cursor: saving ? "wait" : "pointer",
        opacity: saving ? 0.65 : 1,
        outline: "none",
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

function PermissionGroup({
  actions,
  permissions,
  onSaved,
  onError,
}: {
  actions: typeof EMAIL_ACTIONS;
  permissions: Permission[];
  onSaved: (action: string, level: PermissionLevel) => void;
  onError: (message: string) => void;
}) {
  function getPermission(action: string): PermissionLevel {
    return (
      permissions.find(
        (permission) => permission.action === action
      )?.level ?? "approval_required"
    );
  }

  return (
    <div
      style={{
        border: "1px solid #e4e4e7",
        borderRadius: 13,
        overflow: "hidden",
      }}
    >
      {actions.map((action, index) => {
        const level = getPermission(action.key);

        return (
          <div
            key={action.key}
            style={{
              padding: "18px",
              borderTop:
                index === 0 ? "none" : "1px solid #f0f0f1",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 20,
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  flex: "1 1 300px",
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#18181b",
                    marginBottom: 5,
                  }}
                >
                  {action.label}
                </div>

                <div
                  style={{
                    color: "#71717a",
                    fontSize: 13,
                    lineHeight: 1.55,
                    maxWidth: 600,
                  }}
                >
                  {action.description}
                </div>

                <div style={{ marginTop: 9 }}>
                  <PermissionBadge level={level} />
                </div>
              </div>

              <div
                style={{
                  flex: "0 0 auto",
                  paddingTop: 2,
                }}
              >
                <PermissionSelect
                  action={action.key}
                  level={level}
                  onSaved={onSaved}
                  onError={onError}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LoadingBlock() {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e4e4e7",
        borderRadius: 18,
        padding: 28,
      }}
    >
      <div
        style={{
          width: 180,
          height: 15,
          borderRadius: 7,
          background: "#f4f4f5",
          marginBottom: 13,
        }}
      />

      <div
        style={{
          width: "75%",
          height: 12,
          borderRadius: 6,
          background: "#f4f4f5",
          marginBottom: 8,
        }}
      />

      <div
        style={{
          width: "55%",
          height: 12,
          borderRadius: 6,
          background: "#f4f4f5",
        }}
      />
    </div>
  );
}

export default function AgentPage() {
  const [instructions, setInstructions] = useState("");
  const [rules, setRules] = useState<Rule[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);

  const [loading, setLoading] = useState(true);

  const [newRule, setNewRule] = useState("");
  const [savingRule, setSavingRule] = useState(false);
  const [deletingRule, setDeletingRule] = useState<number | null>(null);

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(true);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [savingKnowledge, setSavingKnowledge] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingKnowledge, setDeletingKnowledge] =
    useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<
    "success" | "error"
  >("success");

  function showMessage(
    text: string,
    type: "success" | "error" = "success"
  ) {
    setMessage(text);
    setMessageType(type);

    window.setTimeout(() => {
      setMessage((current) =>
        current === text ? "" : current
      );
    }, 4000);
  }

  useEffect(() => {
    async function loadAgent() {
      try {
        const response = await fetch("/api/agent/settings");

        if (!response.ok) {
          throw new Error("Failed to load agent settings.");
        }

        const data = await response.json();

        setInstructions(data.customInstructions ?? "");
        setRules(Array.isArray(data.rules) ? data.rules : []);
        setPermissions(
          Array.isArray(data.permissions) ? data.permissions : []
        );
      } catch (error) {
        console.error(error);

        showMessage(
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
    try {
      const response = await fetch("/api/knowledge", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Failed to load business knowledge.");
      }

      const data = await response.json();

      setDocuments(
        Array.isArray(data.documents) ? data.documents : []
      );
    } catch (error) {
      console.error(error);

      showMessage(
        error instanceof Error
          ? error.message
          : "Failed to load business knowledge.",
        "error"
      );
    } finally {
      setKnowledgeLoading(false);
    }
  }

  useEffect(() => {
    loadKnowledge();
  }, []);

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

      return [...current, { action, level }];
    });

    showMessage("Permission saved.");
  }

  function handlePermissionError(errorMessage: string) {
    showMessage(errorMessage, "error");
  }

  async function handleInstructionsSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    try {
      const formData = new FormData(event.currentTarget);

      await saveInstructions(formData);

      showMessage("Instructions saved.");
    } catch (error) {
      showMessage(
        error instanceof Error
          ? error.message
          : "Failed to save instructions.",
        "error"
      );
    }
  }

  async function handleAddRule() {
    const trimmed = newRule.trim();

    if (!trimmed) return;

    setSavingRule(true);

    try {
      const formData = new FormData();
      formData.append("description", trimmed);

      await addRule(formData);

      setRules((current) => [
        ...current,
        { description: trimmed },
      ]);

      setNewRule("");

      showMessage("Rule added.");
    } catch (error) {
      showMessage(
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
    setDeletingRule(index);

    try {
      const formData = new FormData();
      formData.append("index", String(index));

      await deleteRule(formData);

      setRules((current) =>
        current.filter((_, ruleIndex) => ruleIndex !== index)
      );

      showMessage("Rule removed.");
    } catch (error) {
      showMessage(
        error instanceof Error
          ? error.message
          : "Failed to remove rule.",
        "error"
      );
    } finally {
      setDeletingRule(null);
    }
  }

  async function handleManualKnowledge() {
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();

    if (!trimmedTitle || !trimmedContent) {
      showMessage(
        "Please enter both a title and the knowledge.",
        "error"
      );
      return;
    }

    setSavingKnowledge(true);

    try {
      const response = await fetch("/api/knowledge/manual", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: trimmedTitle,
          content: trimmedContent,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Failed to save knowledge."
        );
      }

      setTitle("");
      setContent("");

      await loadKnowledge();

      showMessage(
        `Knowledge added successfully. ${
          data.chunksCreated ?? 0
        } knowledge ${
          data.chunksCreated === 1 ? "chunk" : "chunks"
        } created.`
      );
    } catch (error) {
      showMessage(
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
    const input = event.currentTarget;
    const file = input.files?.[0];

    if (!file) return;

    setUploading(true);
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/knowledge/upload", {
        method: "POST",
        body: formData,
      });

      /*
       * The upload route should normally return JSON.
       * If the server crashes and Next.js returns its HTML
       * 500 page, don't show the confusing "Unexpected token <"
       * message to the user.
       */
      const contentType =
        response.headers.get("content-type") ?? "";

      let data: {
        error?: string;
        chunksCreated?: number;
      } = {};

      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        const text = await response.text();

        console.error(
          "Knowledge upload returned non-JSON response:",
          response.status,
          text
        );

        throw new Error(
          response.status >= 500
            ? "The server could not process this document. Please try again."
            : "The document upload failed."
        );
      }

      if (!response.ok) {
        throw new Error(
          data.error || "Upload failed."
        );
      }

      await loadKnowledge();

      showMessage(
        `Uploaded successfully. ${
          data.chunksCreated ?? 0
        } knowledge ${
          data.chunksCreated === 1 ? "chunk" : "chunks"
        } created.`
      );

      input.value = "";
    } catch (error) {
      showMessage(
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
    const confirmed = window.confirm(
      "Delete this knowledge? The agent will no longer use it."
    );

    if (!confirmed) return;

    setDeletingKnowledge(id);

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

      setDocuments((current) =>
        current.filter((document) => document.id !== id)
      );

      showMessage("Knowledge deleted.");
    } catch (error) {
      showMessage(
        error instanceof Error
          ? error.message
          : "Failed to delete knowledge.",
        "error"
      );
    } finally {
      setDeletingKnowledge(null);
    }
  }

  if (loading) {
    return (
      <main
        style={{
          minHeight: "100vh",
          background: "#fafafa",
          padding: "48px 24px 80px",
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 980,
            margin: "0 auto",
          }}
        >
          <LoadingBlock />
          <div style={{ height: 16 }} />
          <LoadingBlock />
        </div>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#fafafa",
        color: "#18181b",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: "44px 24px 80px",
        }}
      >
        {/* Header */}
        <header style={{ marginBottom: 34 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "6px 10px",
              borderRadius: 999,
              background: "#f4f4f5",
              color: "#52525b",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.02em",
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
            AI AGENT
          </div>

          <h1
            style={{
              margin: 0,
              fontSize: 38,
              lineHeight: 1.12,
              letterSpacing: "-0.04em",
              fontWeight: 750,
            }}
          >
            Agent setup
          </h1>

          <p
            style={{
              margin: "10px 0 0",
              maxWidth: 690,
              color: "#71717a",
              fontSize: 16,
              lineHeight: 1.65,
            }}
          >
            Teach your agent how your business works, what it
            knows, and exactly what it is allowed to do on your
            behalf.
          </p>
        </header>

        {/* Global status */}
        {message && (
          <div
            role="status"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              marginBottom: 20,
              padding: "12px 14px",
              borderRadius: 11,
              background:
                messageType === "error"
                  ? "#fef2f2"
                  : "#f0fdf4",
              border:
                messageType === "error"
                  ? "1px solid #fecaca"
                  : "1px solid #bbf7d0",
              color:
                messageType === "error"
                  ? "#b91c1c"
                  : "#166534",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <span style={{ fontWeight: 700 }}>
              {messageType === "error" ? "!" : "✓"}
            </span>

            <span>{message}</span>
          </div>
        )}

        {/* Instructions */}
        <Card style={{ padding: 26, marginBottom: 20 }}>
          <SectionHeader
            eyebrow="Behavior"
            title="Instructions"
            description="Tell your agent about your business, communication style, priorities, and how you want it to handle customers."
          />

          <form onSubmit={handleInstructionsSubmit}>
            <textarea
              name="customInstructions"
              value={instructions}
              onChange={(event) =>
                setInstructions(event.target.value)
              }
              rows={8}
              placeholder={`Example:

We are a plumbing company serving Brooklyn.

Answer straightforward pricing questions automatically. Be friendly and concise. If a customer asks for a refund or complains about a previous service, ask for approval before making a commitment.`}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: 15,
                border: "1px solid #d4d4d8",
                borderRadius: 11,
                resize: "vertical",
                fontFamily: "inherit",
                fontSize: 14,
                lineHeight: 1.65,
                color: "#18181b",
                outline: "none",
                background: "#fff",
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
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Save instructions
              </button>
            </div>
          </form>
        </Card>

        {/* Email */}
        <Card style={{ padding: 26, marginBottom: 20 }}>
          <SectionHeader
            eyebrow="Permissions"
            title="Email"
            description="Control exactly what your agent can do with Gmail. These permissions are enforced by the application before an action is performed."
          />

          <PermissionGroup
            actions={EMAIL_ACTIONS}
            permissions={permissions}
            onSaved={handlePermissionSaved}
            onError={handlePermissionError}
          />

          <div
            style={{
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: 10,
              background: "#fafafa",
              color: "#71717a",
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            <strong style={{ color: "#52525b" }}>
              Approval required
            </strong>{" "}
            means the agent can prepare the action but cannot
            complete it until you approve it.
          </div>
        </Card>

        {/* Calendar */}
        <Card style={{ padding: 26, marginBottom: 20 }}>
          <SectionHeader
            eyebrow="Permissions"
            title="Calendar"
            description="Choose whether your agent can view availability and manage calendar events."
          />

          <PermissionGroup
            actions={CALENDAR_ACTIONS}
            permissions={permissions}
            onSaved={handlePermissionSaved}
            onError={handlePermissionError}
          />
        </Card>

        {/* Rules */}
        <Card style={{ padding: 26, marginBottom: 20 }}>
          <SectionHeader
            eyebrow="Guardrails"
            title="Rules"
            description="Add specific situations where the agent should behave differently, avoid an action, or ask for your approval."
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
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 14,
                    padding: "13px 15px",
                    border: "1px solid #e4e4e7",
                    borderRadius: 11,
                    background: "#fafafa",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        marginTop: 7,
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "#a1a1aa",
                        flexShrink: 0,
                      }}
                    />

                    <span
                      style={{
                        fontSize: 14,
                        lineHeight: 1.55,
                      }}
                    >
                      {rule.description}
                    </span>
                  </div>

                  <button
                    type="button"
                    disabled={deletingRule === index}
                    onClick={() =>
                      handleDeleteRule(index)
                    }
                    style={{
                      border: 0,
                      background: "transparent",
                      color: "#71717a",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor:
                        deletingRule === index
                          ? "wait"
                          : "pointer",
                      padding: "5px 4px",
                      flexShrink: 0,
                    }}
                  >
                    {deletingRule === index
                      ? "Removing..."
                      : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: 9,
              flexWrap: "wrap",
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
              maxLength={500}
              placeholder="Example: Refund requests always require approval."
              style={{
                flex: "1 1 400px",
                minWidth: 0,
                padding: "11px 13px",
                border: "1px solid #d4d4d8",
                borderRadius: 9,
                fontFamily: "inherit",
                fontSize: 14,
                outline: "none",
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
                minHeight: 42,
                background:
                  savingRule || !newRule.trim()
                    ? "#e4e4e7"
                    : "#18181b",
                color:
                  savingRule || !newRule.trim()
                    ? "#a1a1aa"
                    : "#fff",
                fontSize: 13,
                fontWeight: 700,
                cursor:
                  savingRule || !newRule.trim()
                    ? "default"
                    : "pointer",
              }}
            >
              {savingRule ? "Adding..." : "Add rule"}
            </button>
          </div>
        </Card>

        {/* Knowledge */}
        <Card style={{ padding: 26, marginBottom: 20 }}>
          <SectionHeader
            eyebrow="Knowledge"
            title="Business knowledge"
            description="Give your agent reliable information about your business so it can answer customers accurately without inventing facts."
          />

          {/* Upload */}
          <div
            style={{
              border: "1px dashed #c4c4c9",
              borderRadius: 14,
              padding: 22,
              background:
                "linear-gradient(180deg, #fcfcfc 0%, #fafafa 100%)",
              marginBottom: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 13,
              }}
            >
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: "#18181b",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 17,
                  flexShrink: 0,
                }}
              >
                ↑
              </div>

              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    marginBottom: 5,
                  }}
                >
                  Upload a document
                </div>

                <div
                  style={{
                    color: "#71717a",
                    fontSize: 13,
                    lineHeight: 1.55,
                    marginBottom: 14,
                  }}
                >
                  Upload pricing, FAQs, policies, product
                  information, or other business documents.
                  PDF, DOCX, and TXT files up to 10 MB.
                </div>

                <input
                  type="file"
                  accept=".pdf,.docx,.txt"
                  onChange={handleUpload}
                  disabled={uploading}
                  style={{
                    fontSize: 13,
                    maxWidth: "100%",
                  }}
                />

                {uploading && (
                  <div
                    style={{
                      marginTop: 10,
                      color: "#71717a",
                      fontSize: 12,
                    }}
                  >
                    Uploading and indexing your document...
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Manual knowledge */}
          <div
            style={{
              border: "1px solid #e4e4e7",
              borderRadius: 14,
              padding: 22,
              marginBottom: 22,
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                marginBottom: 5,
              }}
            >
              Add individual knowledge
            </div>

            <div
              style={{
                color: "#71717a",
                fontSize: 13,
                lineHeight: 1.55,
                marginBottom: 15,
              }}
            >
              Add a specific fact, price, policy, or instruction
              directly to your agent's knowledge base.
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
                outline: "none",
              }}
            />

            <textarea
              value={content}
              onChange={(event) =>
                setContent(event.target.value)
              }
              placeholder="Emergency plumbing service costs $250 after 6 PM."
              rows={5}
              maxLength={100000}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "11px 13px",
                border: "1px solid #d4d4d8",
                borderRadius: 9,
                resize: "vertical",
                fontFamily: "inherit",
                fontSize: 14,
                lineHeight: 1.55,
                outline: "none",
              }}
            />

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                marginTop: 10,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  color: "#a1a1aa",
                  fontSize: 11,
                }}
              >
                {content.length.toLocaleString()} / 100,000
              </span>

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
                  fontWeight: 700,
                  cursor:
                    savingKnowledge ||
                    !title.trim() ||
                    !content.trim()
                      ? "default"
                      : "pointer",
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
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "#52525b",
                }}
              >
                Your knowledge
              </div>

              {!knowledgeLoading && documents.length > 0 && (
                <div
                  style={{
                    fontSize: 11,
                    color: "#a1a1aa",
                  }}
                >
                  {documents.length}{" "}
                  {documents.length === 1
                    ? "source"
                    : "sources"}
                </div>
              )}
            </div>

            {knowledgeLoading ? (
              <div
                style={{
                  padding: 22,
                  border: "1px solid #e4e4e7",
                  borderRadius: 11,
                  color: "#71717a",
                  fontSize: 13,
                }}
              >
                Loading knowledge...
              </div>
            ) : documents.length === 0 ? (
              <div
                style={{
                  padding: "30px 20px",
                  border: "1px solid #e4e4e7",
                  borderRadius: 11,
                  color: "#71717a",
                  fontSize: 13,
                  textAlign: "center",
                  background: "#fafafa",
                }}
              >
                <div
                  style={{
                    fontSize: 22,
                    marginBottom: 7,
                    opacity: 0.45,
                  }}
                >
                  ◇
                </div>

                <div
                  style={{
                    fontWeight: 600,
                    color: "#52525b",
                    marginBottom: 4,
                  }}
                >
                  No business knowledge yet
                </div>

                <div>
                  Upload a document or add an individual
                  knowledge entry above.
                </div>
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
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 15,
                      padding: "14px 15px",
                      border: "1px solid #e4e4e7",
                      borderRadius: 11,
                      background: "#fff",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 9,
                          background: "#f4f4f5",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#52525b",
                          fontSize: 13,
                          fontWeight: 700,
                          flexShrink: 0,
                        }}
                      >
                        {document.file_name
                          .toLowerCase()
                          .endsWith(".pdf")
                          ? "PDF"
                          : document.file_name
                              .toLowerCase()
                              .endsWith(".docx")
                          ? "DOC"
                          : "TXT"}
                      </div>

                      <div
                        style={{
                          minWidth: 0,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 650,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {document.file_name}
                        </div>

                        <div
                          style={{
                            fontSize: 11,
                            color: "#a1a1aa",
                            marginTop: 4,
                          }}
                        >
                          {document.chunk_count}{" "}
                          {document.chunk_count === 1
                            ? "knowledge chunk"
                            : "knowledge chunks"}{" "}
                          ·{" "}
                          {new Date(
                            document.uploaded_at
                          ).toLocaleDateString()}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={
                        deletingKnowledge === document.id
                      }
                      onClick={() =>
                        handleDeleteKnowledge(document.id)
                      }
                      style={{
                        border: 0,
                        background: "transparent",
                        color: "#71717a",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor:
                          deletingKnowledge === document.id
                            ? "wait"
                            : "pointer",
                        padding: "6px 4px",
                        flexShrink: 0,
                      }}
                    >
                      {deletingKnowledge === document.id
                        ? "Deleting..."
                        : "Delete"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Security note */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "8px 20px",
          }}
        >
          <div
            style={{
              maxWidth: 700,
              textAlign: "center",
              color: "#a1a1aa",
              fontSize: 11,
              lineHeight: 1.65,
            }}
          >
            Your permissions are enforced by the application
            before the AI can perform an action. The AI cannot
            override these settings.
          </div>
        </div>
      </div>
    </main>
  );
}