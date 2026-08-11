"use client";

import { useEffect, useState } from "react";

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
    <main
      style={{
        maxWidth: 900,
        margin: "40px auto",
        padding: "0 20px",
        fontFamily: "system-ui",
      }}
    >
      <h1>Business Knowledge</h1>

      <p style={{ color: "#666", marginBottom: 32 }}>
        Give your AI agent the information it needs to answer customers
        accurately.
      </p>

      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 12,
          padding: 24,
          marginBottom: 24,
        }}
      >
        <h2>Upload a document</h2>

        <p style={{ color: "#666" }}>
          Upload a PDF, Word document, or TXT file containing business
          information, policies, pricing, FAQs, etc.
        </p>

        <input
          type="file"
          accept=".pdf,.docx,.txt"
          onChange={handleFileUpload}
          disabled={uploading}
        />

        {uploading && (
          <p style={{ marginTop: 12 }}>
            Uploading and indexing...
          </p>
        )}

        {uploadMessage && (
          <p style={{ marginTop: 12 }}>
            {uploadMessage}
          </p>
        )}
      </section>

      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 12,
          padding: 24,
          marginBottom: 32,
        }}
      >
        <h2>Add individual knowledge</h2>

        <p style={{ color: "#666" }}>
          Add one specific fact, policy, price, or instruction at a time.
        </p>

        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          style={{
            width: "100%",
            padding: 10,
            marginBottom: 12,
            border: "1px solid #ccc",
            borderRadius: 6,
          }}
        />

        <textarea
          placeholder="Example: Emergency plumbing service costs $250 after 6 PM."
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={5}
          style={{
            width: "100%",
            padding: 10,
            border: "1px solid #ccc",
            borderRadius: 6,
            resize: "vertical",
          }}
        />

        <button
          onClick={handleManualEntry}
          disabled={savingEntry}
          style={{
            marginTop: 12,
            padding: "10px 18px",
            border: "none",
            borderRadius: 6,
            cursor: savingEntry ? "default" : "pointer",
          }}
        >
          {savingEntry ? "Saving..." : "Add Knowledge"}
        </button>

        {entryMessage && (
          <p style={{ marginTop: 12 }}>
            {entryMessage}
          </p>
        )}
      </section>

      <section>
        <h2>Current knowledge</h2>

        {loading ? (
          <p>Loading...</p>
        ) : documents.length === 0 ? (
          <p style={{ color: "#666" }}>
            No business knowledge has been added yet.
          </p>
        ) : (
          <div>
            {documents.map((document) => (
              <div
                key={document.id}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  padding: 18,
                  marginBottom: 12,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 20,
                }}
              >
                <div>
                  <strong>{document.file_name}</strong>

                  <div
                    style={{
                      color: "#666",
                      fontSize: 14,
                      marginTop: 4,
                    }}
                  >
                    {document.chunk_count} knowledge chunks
                  </div>

                  <div
                    style={{
                      color: "#999",
                      fontSize: 13,
                      marginTop: 4,
                    }}
                  >
                    {new Date(
                      document.uploaded_at
                    ).toLocaleDateString()}
                  </div>
                </div>

                <button
                  onClick={() => deleteDocument(document.id)}
                  style={{
                    padding: "8px 12px",
                    border: "1px solid #ccc",
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}