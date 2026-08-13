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

type Rule = {
  description: string;
};

type KnowledgeDetails = {
  id: string;
  file_name: string;
  storage_path: string;
  uploaded_at: string | null;
  chunk_count: number;
  content: string;
  chunks: {
    id: string;
    index: number;
    content: string;
  }[];
};

const EMAIL_ACTIONS = [
  {
    key: "gmail.read",
    label: "Read & search email",
    description:
      "Allow the agent to read incoming emails and search your mailbox.",
    defaultLevel: "allowed" as PermissionLevel,
  },
  {
    key: "gmail.draft",
    label: "Create email drafts",
    description:
      "Allow the agent to prepare replies in Gmail without sending them.",
    defaultLevel: "allowed" as PermissionLevel,
  },
  {
    key: "gmail.send",
    label: "Send email",
    description:
      "Allow the agent to send emails to customers automatically.",
    defaultLevel: "approval_required" as PermissionLevel,
  },
  {
    key: "gmail.archive",
    label: "Archive email",
    description:
      "Allow the agent to archive emails after processing them.",
    defaultLevel: "approval_required" as PermissionLevel,
  },
  {
    key: "gmail.delete",
    label: "Delete email",
    description:
      "Allow the agent to permanently delete emails.",
    defaultLevel: "approval_required" as PermissionLevel,
  },
];

const CALENDAR_ACTIONS = [
  {
    key: "calendar.read",
    label: "Read calendar & availability",
    description:
      "Allow the agent to see your calendar and check available times.",
    defaultLevel: "allowed" as PermissionLevel,
  },
  {
    key: "calendar.write",
    label: "Create & modify events",
    description:
      "Allow the agent to schedule or modify calendar events.",
    defaultLevel: "approval_required" as PermissionLevel,
  },
  {
    key: "calendar.meet",
    label: "Set up Google Meet meetings",
    description:
      "Allow the agent to create Google Meet links when scheduling calendar events.",
    defaultLevel: "approval_required" as PermissionLevel,
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
          fontWeight: 650,
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
          padding: "5px 10px",
          borderRadius: 999,
          background: "#fff7ed",
          color: "#c2410c",
          fontSize: 12,
          fontWeight: 650,
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
        padding: "5px 10px",
        borderRadius: 999,
        background: "#f4f4f5",
        color: "#52525b",
        fontSize: 12,
        fontWeight: 650,
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
  defaultLevel,
  onSaved,
  onError,
}: {
  action: string;
  level: PermissionLevel;
  defaultLevel: PermissionLevel;
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
      name="level"
      value={selectedLevel}
      onChange={handleChange}
      disabled={saving}
      aria-label={`Permission for ${action}`}
      style={{
        minWidth: 185,
        padding: "10px 38px 10px 13px",
        border: "1px solid #d4d4d8",
        borderRadius: 10,
        background: saving ? "#f4f4f5" : "#fff",
        fontSize: 13,
        fontWeight: 550,
        color: "#18181b",
        cursor: saving ? "wait" : "pointer",
        opacity: saving ? 0.7 : 1,
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
          fontWeight: 750,
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
          color: "#18181b",
          letterSpacing: "-0.025em",
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
          maxWidth: 700,
        }}
      >
        {description}
      </p>
    </div>
  );
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(15, 23, 42, 0.42)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        backdropFilter: "blur(3px)",
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 720,
          maxHeight: "min(760px, calc(100vh - 48px))",
          background: "#fff",
          borderRadius: 18,
          border: "1px solid #e4e4e7",
          boxShadow:
            "0 24px 70px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "22px 24px",
            borderBottom: "1px solid #f0f0f1",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 20,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h3
              style={{
                margin: 0,
                fontSize: 18,
                letterSpacing: "-0.02em",
                color: "#18181b",
              }}
            >
              {title}
            </h3>

            {subtitle && (
              <p
                style={{
                  margin: "5px 0 0",
                  color: "#71717a",
                  fontSize: 13,
                }}
              >
                {subtitle}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 34,
              height: 34,
              border: "1px solid #e4e4e7",
              borderRadius: 9,
              background: "#fff",
              color: "#52525b",
              fontSize: 19,
              lineHeight: 1,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            padding: 24,
            overflowY: "auto",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function RuleDetailsModal({
  rule,
  index,
  onClose,
}: {
  rule: Rule;
  index: number;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Rule details"
      subtitle={`Rule ${index + 1}`}
      onClose={onClose}
    >
      <div
        style={{
          border: "1px solid #e4e4e7",
          borderRadius: 12,
          padding: 20,
          background: "#fafafa",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "#71717a",
            marginBottom: 10,
          }}
        >
          Agent rule
        </div>

        <div
          style={{
            fontSize: 15,
            lineHeight: 1.7,
            color: "#27272a",
            whiteSpace: "pre-wrap",
          }}
        >
          {rule.description}
        </div>
      </div>
    </Modal>
  );
}

function KnowledgeDetailsModal({
  knowledge,
  loading,
  onClose,
}: {
  knowledge: KnowledgeDetails | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      title={knowledge?.file_name ?? "Knowledge details"}
      subtitle={
        knowledge
          ? `${knowledge.chunk_count} ${
              knowledge.chunk_count === 1
                ? "chunk"
                : "chunks"
            }`
          : "Loading..."
      }
      onClose={onClose}
    >
      {loading || !knowledge ? (
        <div
          style={{
            padding: "50px 20px",
            textAlign: "center",
            color: "#71717a",
            fontSize: 14,
          }}
        >
          Loading knowledge...
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 18,
            }}
          >
            <span
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                background: "#f4f4f5",
                color: "#52525b",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {knowledge.chunk_count}{" "}
              {knowledge.chunk_count === 1
                ? "chunk"
                : "chunks"}
            </span>

            {knowledge.uploaded_at && (
              <span
                style={{
                  padding: "6px 10px",
                  borderRadius: 999,
                  background: "#f4f4f5",
                  color: "#52525b",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Added{" "}
                {new Date(
                  knowledge.uploaded_at
                ).toLocaleDateString()}
              </span>
            )}
          </div>

          <div
            style={{
              border: "1px solid #e4e4e7",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "11px 15px",
                background: "#fafafa",
                borderBottom: "1px solid #e4e4e7",
                fontSize: 12,
                fontWeight: 700,
                color: "#52525b",
              }}
            >
              Saved knowledge
            </div>

            <div
              style={{
                padding: 18,
                fontSize: 14,
                lineHeight: 1.7,
                color: "#27272a",
                whiteSpace: "pre-wrap",
                maxHeight: 450,
                overflowY: "auto",
              }}
            >
              {knowledge.content || (
                <span style={{ color: "#a1a1aa" }}>
                  No readable content was saved.
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

export default function AgentPage() {
  const [instructions, setInstructions] = useState("");
  const [rules, setRules] = useState<Rule[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);

  const [loading, setLoading] = useState(true);

  const [newRule, setNewRule] = useState("");
  const [savingRule, setSavingRule] = useState(false);

  const [documents, setDocuments] = useState<
    KnowledgeDocument[]
  >([]);
  const [knowledgeLoading, setKnowledgeLoading] =
    useState(true);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [savingKnowledge, setSavingKnowledge] =
    useState(false);
  const [uploading, setUploading] = useState(false);

  const [message, setMessage] = useState("");

  const [selectedKnowledgeId, setSelectedKnowledgeId] =
    useState<string | null>(null);

  const [selectedKnowledge, setSelectedKnowledge] =
    useState<KnowledgeDetails | null>(null);

  const [knowledgeDetailsLoading, setKnowledgeDetailsLoading] =
    useState(false);

  const [selectedRule, setSelectedRule] = useState<{
    rule: Rule;
    index: number;
  } | null>(null);

  useEffect(() => {
    async function loadAgent() {
      try {
        const response = await fetch(
          "/api/agent/settings"
        );

        if (!response.ok) {
          throw new Error(
            "Failed to load agent settings"
          );
        }

        const data = await response.json();

        setInstructions(data.customInstructions ?? "");
        setRules(data.rules ?? []);
        setPermissions(data.permissions ?? []);
      } catch (error) {
        console.error(error);

        setMessage(
          error instanceof Error
            ? error.message
            : "Failed to load agent settings."
        );
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

      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to load knowledge."
      );
    } finally {
      setKnowledgeLoading(false);
    }
  }

  useEffect(() => {
    loadKnowledge();
  }, []);

  async function viewKnowledge(id: string) {
    setSelectedKnowledgeId(id);
    setSelectedKnowledge(null);
    setKnowledgeDetailsLoading(true);

    try {
      const response = await fetch(
        `/api/knowledge/${id}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            "Failed to load knowledge details."
        );
      }

      setSelectedKnowledge(data.document);
    } catch (error) {
      setSelectedKnowledgeId(null);

      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to load knowledge details."
      );
    } finally {
      setKnowledgeDetailsLoading(false);
    }
  }

  function closeKnowledge() {
    setSelectedKnowledgeId(null);
    setSelectedKnowledge(null);
  }

  function getPermission(
    action: string,
    defaultLevel: PermissionLevel
  ): PermissionLevel {
    return (
      permissions.find(
        (permission) => permission.action === action
      )?.level ?? defaultLevel
    );
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

    setMessage("Permission saved.");
  }

  function handlePermissionError(
    errorMessage: string
  ) {
    setMessage(errorMessage);
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
      const description = newRule.trim();

      const formData = new FormData();

      formData.append(
        "description",
        description
      );

      await addRule(formData);

      setRules((current) => [
        ...current,
        {
          description,
        },
      ]);

      setNewRule("");

      setMessage("Rule added.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to add rule."
      );
    } finally {
      setSavingRule(false);
    }
  }

  async function handleDeleteRule(index: number) {
    try {
      const formData = new FormData();

      formData.append(
        "index",
        String(index)
      );

      await deleteRule(formData);

      setRules((current) =>
        current.filter(
          (_, ruleIndex) =>
            ruleIndex !== index
        )
      );

      setSelectedRule(null);

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
    if (
      !title.trim() ||
      !content.trim()
    ) {
      setMessage(
        "Please enter both a title and the knowledge."
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
            "Content-Type":
              "application/json",
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
          data.error ||
            "Failed to save knowledge."
        );
      }

      setTitle("");
      setContent("");

      setMessage(
        "Knowledge added successfully."
      );

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
    const file =
      event.target.files?.[0];

    if (!file) return;

    setUploading(true);
    setMessage("");

    try {
      const formData = new FormData();

      formData.append(
        "file",
        file
      );

      const response = await fetch(
        "/api/knowledge/upload",
        {
          method: "POST",
          body: formData,
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            "Upload failed."
        );
      }

      setMessage(
        `Uploaded successfully. ${data.chunksCreated} knowledge ${
          data.chunksCreated === 1
            ? "chunk"
            : "chunks"
        } created.`
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

  async function handleDeleteKnowledge(
    id: string
  ) {
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

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            "Failed to delete knowledge."
        );
      }

      if (
        selectedKnowledgeId === id
      ) {
        closeKnowledge();
      }

      await loadKnowledge();

      setMessage(
        "Knowledge deleted."
      );
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
          minHeight: "100vh",
          background: "#fafafa",
          padding: "48px 24px",
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
        </div>
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
          padding:
            "48px 24px 80px",
        }}
      >
        <header
          style={{
            marginBottom: 38,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding:
                "6px 10px",
              borderRadius: 999,
              background: "#f4f4f5",
              color: "#52525b",
              fontSize: 12,
              fontWeight: 650,
              marginBottom: 14,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background:
                  "#22c55e",
              }}
            />

            AI Agent
          </div>

          <h1
            style={{
              margin: 0,
              fontSize: 36,
              lineHeight: 1.15,
              letterSpacing:
                "-0.035em",
            }}
          >
            Agent setup
          </h1>

          <p
            style={{
              margin:
                "10px 0 0",
              maxWidth: 650,
              fontSize: 16,
              lineHeight: 1.6,
              color: "#71717a",
            }}
          >
            Teach your AI agent how
            your business works and
            decide exactly what it is
            allowed to do on your
            behalf.
          </p>
        </header>

        {message && (
          <div
            style={{
              marginBottom: 20,
              padding:
                "12px 15px",
              borderRadius: 10,
              background:
                "#f0fdf4",
              border:
                "1px solid #bbf7d0",
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
            border:
              "1px solid #e4e4e7",
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

          <form
            onSubmit={
              handleInstructionsSubmit
            }
          >
            <textarea
              name="customInstructions"
              value={instructions}
              onChange={(event) =>
                setInstructions(
                  event.target.value
                )
              }
              rows={7}
              placeholder={`Example:

We are a plumbing company serving Brooklyn.

Answer straightforward pricing questions automatically. Be friendly and concise. If a customer asks for a refund or complains about a previous service, do not make a commitment without approval.`}
              style={{
                width: "100%",
                boxSizing:
                  "border-box",
                padding: 15,
                border:
                  "1px solid #d4d4d8",
                borderRadius: 10,
                resize: "vertical",
                fontFamily:
                  "inherit",
                fontSize: 14,
                lineHeight: 1.6,
                outline: "none",
              }}
            />

            <div
              style={{
                display: "flex",
                justifyContent:
                  "flex-end",
                marginTop: 12,
              }}
            >
              <button
                type="submit"
                style={{
                  border: 0,
                  borderRadius: 9,
                  padding:
                    "10px 17px",
                  background:
                    "#18181b",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor:
                    "pointer",
                }}
              >
                Save instructions
              </button>
            </div>
          </form>
        </section>

        {/* Email */}
        <section
          style={{
            background: "#fff",
            border:
              "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 26,
            marginBottom: 20,
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
              border:
                "1px solid #e4e4e7",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {EMAIL_ACTIONS.map(
              (action, index) => {
                const level =
                  getPermission(
                    action.key,
                    action.defaultLevel
                  );

                return (
                  <div
                    key={action.key}
                    style={{
                      display:
                        "flex",
                      alignItems:
                        "center",
                      justifyContent:
                        "space-between",
                      gap: 24,
                      padding:
                        "17px 18px",
                      borderTop:
                        index === 0
                          ? "none"
                          : "1px solid #f0f0f1",
                    }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight:
                            600,
                          marginBottom: 4,
                        }}
                      >
                        {action.label}
                      </div>

                      <div
                        style={{
                          fontSize: 13,
                          color:
                            "#71717a",
                          lineHeight:
                            1.45,
                        }}
                      >
                        {
                          action.description
                        }
                      </div>

                      <div
                        style={{
                          marginTop: 8,
                        }}
                      >
                        <PermissionBadge
                          level={
                            level
                          }
                        />
                      </div>
                    </div>

                    <PermissionSelect
                      action={
                        action.key
                      }
                      level={level}
                      defaultLevel={
                        action.defaultLevel
                      }
                      onSaved={
                        handlePermissionSaved
                      }
                      onError={
                        handlePermissionError
                      }
                    />
                  </div>
                );
              }
            )}
          </div>

          <div
            style={{
              marginTop: 15,
              padding: 13,
              borderRadius: 10,
              background:
                "#fafafa",
              color: "#71717a",
              fontSize: 12,
              lineHeight: 1.55,
            }}
          >
            <strong
              style={{
                color:
                  "#52525b",
              }}
            >
              Approval required
            </strong>{" "}
            means the agent can
            prepare the action, but
            it cannot complete it
            until you approve it.
          </div>
        </section>

        {/* Calendar */}
        <section
          style={{
            background: "#fff",
            border:
              "1px solid #e4e4e7",
            borderRadius: 16,
            padding: 26,
            marginBottom: 20,
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.03)",
          }}
        >
          <SectionHeader
            eyebrow="Permissions"
            title="Calendar & meetings"
            description="Choose what your agent can see and manage in your calendar, including whether it can create Google Meet links."
          />

          <div
            style={{
              border:
                "1px solid #e4e4e7",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {CALENDAR_ACTIONS.map(
              (action, index) => {
                const level =
                  getPermission(
                    action.key,
                    action.defaultLevel
                  );

                return (
                  <div
                    key={action.key}
                    style={{
                      display:
                        "flex",
                      alignItems:
                        "center",
                      justifyContent:
                        "space-between",
                      gap: 24,
                      padding:
                        "17px 18px",
                      borderTop:
                        index === 0
                          ? "none"
                          : "1px solid #f0f0f1",
                    }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight:
                            600,
                          marginBottom: 4,
                        }}
                      >
                        {action.label}
                      </div>

                      <div
                        style={{
                          fontSize: 13,
                          color:
                            "#71717a",
                          lineHeight:
                            1.45,
                        }}
                      >
                        {
                          action.description
                        }
                      </div>

                      <div
                        style={{
                          marginTop: 8,
                        }}
                      >
                        <PermissionBadge
                          level={
                            level
                          }
                        />
                      </div>
                    </div>

                    <PermissionSelect
                      action={
                        action.key
                      }
                      level={level}
                      defaultLevel={
                        action.defaultLevel
                      }
                      onSaved={
                        handlePermissionSaved
                      }
                      onError={
                        handlePermissionError
                      }
                    />
                  </div>
                );
              }
            )}
          </div>
        </section>

        {/* Rules */}
        <section
          style={{
            background: "#fff",
            border:
              "1px solid #e4e4e7",
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
              {rules.map(
                (rule, index) => (
                  <div
                    key={`${rule.description}-${index}`}
                    style={{
                      display:
                        "flex",
                      alignItems:
                        "center",
                      justifyContent:
                        "space-between",
                      gap: 15,
                      padding:
                        "13px 15px",
                      border:
                        "1px solid #e4e4e7",
                      borderRadius: 10,
                      background:
                        "#fafafa",
                    }}
                  >
                    <div
                      style={{
                        display:
                          "flex",
                        gap: 10,
                        alignItems:
                          "flex-start",
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          marginTop: 5,
                          width: 7,
                          height: 7,
                          borderRadius:
                            "50%",
                          background:
                            "#a1a1aa",
                          flexShrink: 0,
                        }}
                      />

                      <span
                        style={{
                          fontSize: 14,
                          lineHeight:
                            1.5,
                          overflow:
                            "hidden",
                          textOverflow:
                            "ellipsis",
                          whiteSpace:
                            "nowrap",
                        }}
                      >
                        {
                          rule.description
                        }
                      </span>
                    </div>

                    <div
                      style={{
                        display:
                          "flex",
                        alignItems:
                          "center",
                        gap: 6,
                        flexShrink: 0,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedRule(
                            {
                              rule,
                              index,
                            }
                          )
                        }
                        style={{
                          border:
                            "1px solid #e4e4e7",
                          background:
                            "#fff",
                          color:
                            "#52525b",
                          borderRadius: 8,
                          padding:
                            "6px 9px",
                          fontSize: 12,
                          fontWeight:
                            600,
                          cursor:
                            "pointer",
                        }}
                      >
                        View
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          handleDeleteRule(
                            index
                          )
                        }
                        style={{
                          border: 0,
                          background:
                            "transparent",
                          color:
                            "#71717a",
                          fontSize: 12,
                          cursor:
                            "pointer",
                          padding:
                            "6px 7px",
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )
              )}
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
                setNewRule(
                  event.target.value
                )
              }
              onKeyDown={(event) => {
                if (
                  event.key ===
                  "Enter"
                ) {
                  event.preventDefault();
                  handleAddRule();
                }
              }}
              placeholder="Example: Refund requests always require approval."
              style={{
                flex: 1,
                minWidth: 0,
                padding:
                  "11px 13px",
                border:
                  "1px solid #d4d4d8",
                borderRadius: 9,
                fontFamily:
                  "inherit",
                fontSize: 14,
              }}
            />

            <button
              type="button"
              onClick={
                handleAddRule
              }
              disabled={
                savingRule ||
                !newRule.trim()
              }
              style={{
                border: 0,
                borderRadius: 9,
                padding:
                  "0 17px",
                background:
                  savingRule ||
                  !newRule.trim()
                    ? "#e4e4e7"
                    : "#18181b",
                color:
                  savingRule ||
                  !newRule.trim()
                    ? "#a1a1aa"
                    : "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor:
                  savingRule ||
                  !newRule.trim()
                    ? "default"
                    : "pointer",
              }}
            >
              {savingRule
                ? "Adding..."
                : "Add rule"}
            </button>
          </div>
        </section>

        {/* Knowledge */}
        <section
          style={{
            background: "#fff",
            border:
              "1px solid #e4e4e7",
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
              border:
                "1px dashed #d4d4d8",
              borderRadius: 12,
              background:
                "#fafafa",
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
              Upload pricing, FAQs,
              policies, product
              information, or other
              business documents.
            </div>

            <input
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={
                handleUpload
              }
              disabled={
                uploading
              }
              style={{
                fontSize: 13,
              }}
            />

            {uploading && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 13,
                  color:
                    "#71717a",
                }}
              >
                Uploading and
                indexing...
              </div>
            )}
          </div>

          {/* Manual knowledge */}
          <div
            style={{
              padding: 20,
              border:
                "1px solid #e4e4e7",
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
              Add individual
              knowledge
            </div>

            <div
              style={{
                fontSize: 13,
                color: "#71717a",
                marginBottom: 15,
              }}
            >
              Add a specific fact,
              price, policy, or
              instruction.
            </div>

            <input
              value={title}
              onChange={(event) =>
                setTitle(
                  event.target.value
                )
              }
              placeholder="Title — e.g. Emergency service pricing"
              style={{
                width: "100%",
                boxSizing:
                  "border-box",
                padding:
                  "11px 13px",
                border:
                  "1px solid #d4d4d8",
                borderRadius: 9,
                fontFamily:
                  "inherit",
                fontSize: 14,
                marginBottom: 10,
              }}
            />

            <textarea
              value={content}
              onChange={(event) =>
                setContent(
                  event.target.value
                )
              }
              placeholder="Emergency plumbing service costs $250 after 6 PM."
              rows={4}
              style={{
                width: "100%",
                boxSizing:
                  "border-box",
                padding:
                  "11px 13px",
                border:
                  "1px solid #d4d4d8",
                borderRadius: 9,
                resize: "vertical",
                fontFamily:
                  "inherit",
                fontSize: 14,
                lineHeight: 1.5,
              }}
            />

            <div
              style={{
                display: "flex",
                justifyContent:
                  "flex-end",
                marginTop: 10,
              }}
            >
              <button
                type="button"
                onClick={
                  handleManualKnowledge
                }
                disabled={
                  savingKnowledge ||
                  !title.trim() ||
                  !content.trim()
                }
                style={{
                  border: 0,
                  borderRadius: 9,
                  padding:
                    "10px 16px",
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
                  cursor:
                    "pointer",
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
                  color:
                    "#71717a",
                  fontSize: 13,
                }}
              >
                Loading knowledge...
              </div>
            ) : documents.length ===
              0 ? (
              <div
                style={{
                  padding: 20,
                  border:
                    "1px solid #e4e4e7",
                  borderRadius: 10,
                  color:
                    "#71717a",
                  fontSize: 13,
                  textAlign:
                    "center",
                }}
              >
                No business
                knowledge has
                been added yet.
              </div>
            ) : (
              <div
                style={{
                  display:
                    "grid",
                  gap: 8,
                }}
              >
                {documents.map(
                  (document) => (
                    <div
                      key={
                        document.id
                      }
                      style={{
                        display:
                          "flex",
                        justifyContent:
                          "space-between",
                        alignItems:
                          "center",
                        gap: 15,
                        padding:
                          "13px 15px",
                        border:
                          "1px solid #e4e4e7",
                        borderRadius: 10,
                      }}
                    >
                      <div
                        style={{
                          minWidth: 0,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight:
                              600,
                            overflow:
                              "hidden",
                            textOverflow:
                              "ellipsis",
                            whiteSpace:
                              "nowrap",
                          }}
                        >
                          {
                            document.file_name
                          }
                        </div>

                        <div
                          style={{
                            fontSize: 12,
                            color:
                              "#a1a1aa",
                            marginTop: 4,
                          }}
                        >
                          {
                            document.chunk_count
                          }{" "}
                          knowledge{" "}
                          {document.chunk_count ===
                          1
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
                          display:
                            "flex",
                          alignItems:
                            "center",
                          gap: 7,
                          flexShrink: 0,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            viewKnowledge(
                              document.id
                            )
                          }
                          style={{
                            border:
                              "1px solid #e4e4e7",
                            background:
                              "#fff",
                            color:
                              "#52525b",
                            borderRadius:
                              8,
                            padding:
                              "7px 10px",
                            fontSize: 12,
                            fontWeight:
                              600,
                            cursor:
                              "pointer",
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
                            background:
                              "transparent",
                            color:
                              "#71717a",
                            fontSize: 12,
                            cursor:
                              "pointer",
                            padding:
                              "7px 6px",
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        </section>

        <div
          style={{
            textAlign:
              "center",
            color:
              "#a1a1aa",
            fontSize: 12,
            lineHeight: 1.6,
            padding:
              "10px 20px",
          }}
        >
          Your permissions are
          enforced by the application
          before the AI can perform an
          action. The AI cannot override
          these settings.
        </div>
      </div>

      {selectedKnowledgeId && (
        <KnowledgeDetailsModal
          knowledge={
            selectedKnowledge
          }
          loading={
            knowledgeDetailsLoading
          }
          onClose={
            closeKnowledge
          }
        />
      )}

      {selectedRule && (
        <RuleDetailsModal
          rule={
            selectedRule.rule
          }
          index={
            selectedRule.index
          }
          onClose={() =>
            setSelectedRule(
              null
            )
          }
        />
      )}
    </main>
  );
}