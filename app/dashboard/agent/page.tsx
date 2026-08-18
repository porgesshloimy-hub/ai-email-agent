"use client";

import { useEffect, useState } from "react";
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
      style={{
        minWidth: 180,
        padding: "9px 34px 9px 12px",
        border: "1px solid #d4d4d8",
        borderRadius: 8,
        background: saving ? "#f4f4f5" : "#fff",
        fontSize: 13,
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

  const [message, setMessage] = useState("");

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

    setMessage("Permission saved.");
  }

  function handlePermissionError(message: string) {
    setMessage(message);
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

      setMessage("Model updated.");
    } catch (error) {
      setAiProvider(previousProvider);
      setAiModel(previousModel);

      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to update model."
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

      setMessage("Knowledge deleted.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to delete knowledge."
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
                    onSaved={handlePermissionSaved}
                    onError={handlePermissionError}
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
            padding: 26,
            marginBottom: 20,
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
                    onSaved={handlePermissionSaved}
                    onError={handlePermissionError}
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
            padding: 26,
            marginBottom: 20,
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
            {ZOOM_ACTIONS.map((action, index) => {
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
                    onSaved={handlePermissionSaved}
                    onError={handlePermissionError}
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
              Automatic
            </strong>{" "}
            lets the agent create Zoom meetings directly.{" "}
            <strong style={{ color: "#52525b" }}>
              Approval required
            </strong>{" "}
            has it propose a meeting for you to confirm first. This requires a connected Zoom account.
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
      `}</style>
    </main>
  );
}