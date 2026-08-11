"use client";

import { useEffect, useState } from "react";
import {
  addRule,
  deleteRule,
  saveInstructions,
  savePermission,
} from "./actions";

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

type Permission = {
  action: string;
  level: PermissionLevel;
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
];

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
          padding: "5px 10px",
          borderRadius: 999,
          background: "#ecfdf3",
          color: "#027a48",
          fontSize: 12,
          fontWeight: 600,
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
          padding: "5px 10px",
          borderRadius: 999,
          background: "#fff7ed",
          color: "#c2410c",
          fontSize: 12,
          fontWeight: 600,
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
        padding: "5px 10px",
        borderRadius: 999,
        background: "#f4f4f5",
        color: "#52525b",
        fontSize: 12,
        fontWeight: 600,
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
}: {
  action: string;
  level: PermissionLevel;
}) {
  return (
    <form action={savePermission}>
      <input type="hidden" name="action" value={action} />

      <select
        name="level"
        defaultValue={level}
        onChange={(event) => {
          event.currentTarget.form?.requestSubmit();
        }}
        style={{
          minWidth: 180,
          padding: "9px 34px 9px 12px",
          border: "1px solid #d4d4d8",
          borderRadius: 8,
          background: "#fff",
          fontSize: 13,
          fontWeight: 500,
          color: "#18181b",
          cursor: "pointer",
        }}
      >
        <option value="denied">Never</option>
        <option value="approval_required">
          Approval required
        </option>
        <option value="allowed">Automatic</option>
      </select>
    </form>
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

export default function AgentPage() {
  const [instructions, setInstructions] = useState("");
  const [rules, setRules] = useState<{ description: string }[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);

  const [loading, setLoading] = useState(true);

  const [newRule, setNewRule] = useState("");
  const [savingRule, setSavingRule] = useState(false);

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(true);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [savingKnowledge, setSavingKnowledge] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [message, setMessage] = useState("");

  useEffect(() => {
    async function loadAgent() {
      try {
        const response = await fetch("/api/agent/settings");

        if (!response.ok) {
          throw new Error("Failed to load agent settings");
        }

        const data = await response.json();

        setInstructions(data.customInstructions ?? "");
        setRules(data.rules ?? []);
        setPermissions(data.permissions ?? []);
      } catch (error) {
        console.error(error);
      } finally {
        setLoading(false);
      }
    }

    loadAgent();
  }, []);

  async function loadKnowledge() {
    try {
      const response = await fetch("/api/knowledge");

      if (!response.ok) {
        throw new Error("Failed to load knowledge");
      }

      const data = await response.json();

      setDocuments(data.documents ?? []);
    } catch (error) {
      console.error(error);
    } finally {
      setKnowledgeLoading(false);
    }
  }

  useEffect(() => {
    loadKnowledge();
  }, []);

  function getPermission(action: string): PermissionLevel {
    return (
      permissions.find((permission) => permission.action === action)
        ?.level ?? "approval_required"
    );
  }

  async function handleInstructionsSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);

    try {
      await saveInstructions(formData);
      setMessage("Instructions saved.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to save instructions."
      );
    }
  }

  async function handleAddRule() {
    if (!newRule.trim()) return;

    setSavingRule(true);

    try {
      const formData = new FormData();
      formData.append("description", newRule.trim());

      await addRule(formData);

      setRules((current) => [
        ...current,
        { description: newRule.trim() },
      ]);

      setNewRule("");
      setMessage("Rule added.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Failed to add rule."
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
        current.filter((_, ruleIndex) => ruleIndex !== index)
      );

      setMessage("Rule removed.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to remove rule."
      );
    }
  }

  async function handleManualKnowledge() {
    if (!title.trim() || !content.trim()) {
      setMessage("Please enter both a title and the knowledge.");
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
          title,
          content,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to save knowledge.");
      }

      setTitle("");
      setContent("");

      setMessage("Knowledge added successfully.");

      await loadKnowledge();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to save knowledge."
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
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/knowledge/upload", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Upload failed.");
      }

      setMessage(
        `Uploaded successfully. ${data.chunksCreated} knowledge chunks created.`
      );

      await loadKnowledge();

      event.target.value = "";
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Upload failed."
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
      const response = await fetch(`/api/knowledge/${id}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to delete knowledge.");
      }

      await loadKnowledge();

      setMessage("Knowledge deleted.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to delete knowledge."
      );
    }
  }

  if (loading) {
    return (
      <main
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: "48px 24px",
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
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
        {/* Header */}
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
            Teach your AI agent how your business works and decide exactly
            what it is allowed to do on your behalf.
          </p>
        </header>

        {message && (
          <div
            style={{
              marginBottom: 20,
              padding: "12px 15px",
              borderRadius: 10,
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              color: "#166534",
              fontSize: 14,
            }}
          >
            {message}
          </div>
        )}

        {/* Instructions */}
        <section
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 26,
            marginBottom: 20,
            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
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

        {/* Email permissions */}
        <section
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 26,
            marginBottom: 20,
            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
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
            {EMAIL_ACTIONS.map((action, index) => {
              const level = getPermission(action.key);

              return (
                <div
                  key={action.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 24,
                    padding: "17px 18px",
                    borderTop:
                      index === 0
                        ? "none"
                        : "1px solid #f0f0f1",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        marginBottom: 4,
                      }}
                    >
                      {action.label}
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        color: "#71717a",
                        lineHeight: 1.45,
                      }}
                    >
                      {action.description}
                    </div>

                    <div style={{ marginTop: 8 }}>
                      <PermissionBadge level={level} />
                    </div>
                  </div>

                  <PermissionSelect
                    action={action.key}
                    level={level}
                  />
                </div>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 15,
              padding: 13,
              borderRadius: 10,
              background: "#fafafa",
              color: "#71717a",
              fontSize: 12,
              lineHeight: 1.55,
            }}
          >
            <strong style={{ color: "#52525b" }}>
              Approval required
            </strong>{" "}
            means the agent can prepare the action, but it cannot complete
            it until you approve it.
          </div>
        </section>

        {/* Calendar */}
        <section
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 26,
            marginBottom: 20,
            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
          }}
        >
          <SectionHeader
            eyebrow="Permissions"
            title="Calendar"
            description="Choose whether your agent can view availability and manage calendar events."
          />

          <div
            style={{
              border: "1px solid #e4e4e7",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {CALENDAR_ACTIONS.map((action, index) => {
              const level = getPermission(action.key);

              return (
                <div
                  key={action.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 24,
                    padding: "17px 18px",
                    borderTop:
                      index === 0
                        ? "none"
                        : "1px solid #f0f0f1",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        marginBottom: 4,
                      }}
                    >
                      {action.label}
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        color: "#71717a",
                        lineHeight: 1.45,
                      }}
                    >
                      {action.description}
                    </div>

                    <div style={{ marginTop: 8 }}>
                      <PermissionBadge level={level} />
                    </div>
                  </div>

                  <PermissionSelect
                    action={action.key}
                    level={level}
                  />
                </div>
              );
            })}
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
            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
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
                      }}
                    >
                      {rule.description}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleDeleteRule(index)}
                    style={{
                      border: 0,
                      background: "transparent",
                      color: "#a1a1aa",
                      fontSize: 13,
                      cursor: "pointer",
                      padding: "5px 7px",
                    }}
                  >
                    Remove
                  </button>
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
              disabled={savingRule || !newRule.trim()}
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
              Add rule
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
            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
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
              Upload pricing, FAQs, policies, product information,
              or other business documents.
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
              Add a specific fact, price, policy, or instruction.
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
                No business knowledge has been added yet.
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
                    <div style={{ minWidth: 0 }}>
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

                    <button
                      type="button"
                      onClick={() =>
                        handleDeleteKnowledge(document.id)
                      }
                      style={{
                        border: 0,
                        background: "transparent",
                        color: "#71717a",
                        fontSize: 12,
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      Delete
                    </button>
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
          Your permissions are enforced by the application before the AI
          can perform an action. The AI cannot override these settings.
        </div>
      </div>
    </main>
  );
}