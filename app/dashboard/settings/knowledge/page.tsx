"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Bento,
  BentoItem,
  Button,
  EmptyState,
  Input,
  Label,
  Page,
  PageHeader,
  Panel,
  PanelTitle,
  SectionHeading,
  Textarea,
} from "@/components/ui";

interface KnowledgeDocument {
  id: string;
  file_name: string;
  storage_path: string;
  uploaded_at: string;
  chunk_count: number;
}

export default function KnowledgePage() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);

  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [savingEntry, setSavingEntry] = useState(false);
  const [entryMessage, setEntryMessage] = useState("");

  async function loadDocuments() {
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
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDocuments();
  }, []);

  async function handleFileUpload(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];

    if (!file) return;

    setUploading(true);
    setUploadMessage("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/knowledge/upload", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Upload failed");
      }

      setUploadMessage(
        `Uploaded successfully. ${data.chunksCreated} knowledge chunks created.`
      );

      await loadDocuments();

      event.target.value = "";
    } catch (error) {
      setUploadMessage(
        error instanceof Error ? error.message : "Upload failed"
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleManualEntry() {
    if (!title.trim() || !content.trim()) {
      setEntryMessage("Please enter both a title and the knowledge.");
      return;
    }

    setSavingEntry(true);
    setEntryMessage("");

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
        throw new Error(data.error || "Failed to save knowledge");
      }

      setTitle("");
      setContent("");

      setEntryMessage(
        `Saved successfully. ${data.chunksCreated} knowledge chunks created.`
      );

      await loadDocuments();
    } catch (error) {
      setEntryMessage(
        error instanceof Error
          ? error.message
          : "Failed to save knowledge"
      );
    } finally {
      setSavingEntry(false);
    }
  }

  async function deleteDocument(id: string) {
    const confirmed = window.confirm(
      "Delete this knowledge? The agent will no longer use it."
    );

    if (!confirmed) return;

    try {
      const response = await fetch(`/api/knowledge/${id}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to delete knowledge");
      }

      await loadDocuments();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Failed to delete knowledge"
      );
    }
  }

  return (
    <Page width="full">
      <PageHeader
        eyebrow="Knowledge"
        title="Business knowledge"
        description="Give your AI agent the information it needs to answer customers accurately."
      />

      <Bento className="mb-12">
        <BentoItem span="md">
          <Panel padding="lg" className="flex h-full flex-col">
            <PanelTitle hint="PDF · DOCX · TXT">Upload a document</PanelTitle>

            <p className="text-sm leading-relaxed text-muted">
              Upload a PDF, Word document, or TXT file containing business information, policies,
              pricing, FAQs, etc.
            </p>

            <div className="mt-5 rounded-control border border-dashed border-line-strong bg-surface-2 p-5">
              <input
                type="file"
                accept=".pdf,.docx,.txt"
                onChange={handleFileUpload}
                disabled={uploading}
                className="focus-ring w-full cursor-pointer text-sm text-ink-2 file:mr-3 file:cursor-pointer file:rounded-control file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-accent-ink disabled:opacity-60"
              />
            </div>

            {uploading && <p className="mt-4 text-sm text-muted">Uploading and indexing...</p>}

            {uploadMessage && <p className="mt-4 text-sm text-ink-2">{uploadMessage}</p>}
          </Panel>
        </BentoItem>

        <BentoItem span="md">
          <Panel padding="lg" className="flex h-full flex-col">
            <PanelTitle>Add individual knowledge</PanelTitle>

            <p className="text-sm leading-relaxed text-muted">
              Add one specific fact, policy, price, or instruction at a time.
            </p>

            <div className="mt-5">
              <Label htmlFor="knowledge-title">Title</Label>
              <Input
                id="knowledge-title"
                type="text"
                placeholder="Emergency call-out pricing"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div className="mt-4">
              <Label htmlFor="knowledge-content">Knowledge</Label>
              <Textarea
                id="knowledge-content"
                placeholder="Example: Emergency plumbing service costs $250 after 6 PM."
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={5}
              />
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button onClick={handleManualEntry} disabled={savingEntry}>
                {savingEntry ? "Saving..." : "Add Knowledge"}
              </Button>

              {entryMessage && <span className="text-sm text-muted">{entryMessage}</span>}
            </div>
          </Panel>
        </BentoItem>
      </Bento>

      <section>
        <SectionHeading
          title="Current knowledge"
          description="Everything the agent can draw on right now."
          actions={
            !loading && documents.length > 0 ? (
              <Badge tone="accent">{documents.length} sources</Badge>
            ) : null
          }
        />

        {loading ? (
          <Panel padding="lg" tone="quiet" className="text-sm text-muted">
            Loading...
          </Panel>
        ) : documents.length === 0 ? (
          <EmptyState
            title="No business knowledge yet"
            description="Upload a document or add a single fact above, and the agent will start using it immediately."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {documents.map((document) => (
              <Panel key={document.id} padding="sm" className="flex flex-wrap items-center gap-4 p-5">
                <div className="min-w-0 flex-1">
                  <strong className="font-display text-[15px] font-semibold text-ink">
                    {document.file_name}
                  </strong>

                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted">
                    <span>{document.chunk_count} knowledge chunks</span>
                    <span className="text-line-strong">·</span>
                    <span>{new Date(document.uploaded_at).toLocaleDateString()}</span>
                  </div>
                </div>

                <Button
                  onClick={() => deleteDocument(document.id)}
                  variant="secondary"
                  size="sm"
                >
                  Delete
                </Button>
              </Panel>
            ))}
          </div>
        )}
      </section>
    </Page>
  );
}
