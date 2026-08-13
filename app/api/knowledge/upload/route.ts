import { NextResponse } from "next/server";
import {
  createServerSupabase,
  createServiceSupabase,
} from "@/lib/supabase/server";
import OpenAI from "openai";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function chunkText(text: string, maxChars = 2500): string[] {
  const cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!cleaned) {
    return [];
  }

  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    const combined = `${current}\n\n${paragraph}`;

    if (combined.length <= maxChars) {
      current = combined;
    } else {
      chunks.push(current);
      current = paragraph;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function extractText(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  // TXT
  if (name.endsWith(".txt")) {
    return buffer.toString("utf8");
  }

  // DOCX
  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({
      buffer,
    });

    return result.value;
  }

  // PDF
  if (name.endsWith(".pdf")) {
    try {
      console.log(
        `[knowledge] Starting PDF extraction: ${file.name}, ${file.size} bytes`
      );

      const result = await pdfParse(buffer);

      console.log(
        `[knowledge] PDF extraction completed: ${file.name}, ${
          result.text?.length ?? 0
        } characters`
      );

      return result.text ?? "";
    } catch (error) {
      console.error("[knowledge] PDF extraction failed:", error);

      throw new Error(
        error instanceof Error
          ? `PDF extraction failed: ${error.message}`
          : "PDF extraction failed."
      );
    }
  }

  throw new Error(
    "Unsupported file type. Please upload a PDF, DOCX, or TXT file."
  );
}

export async function POST(request: Request) {
  let documentId: string | null = null;
  let storagePath: string | null = null;

  try {
    console.log("[knowledge] Upload request started");

    const supabase = await createServerSupabase();

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      console.error("[knowledge] Authentication failed:", userError);

      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("owner_user_id", user.id)
      .single();

    if (tenantError || !tenant) {
      console.error("[knowledge] Tenant lookup failed:", tenantError);

      return NextResponse.json(
        { error: "Tenant not found" },
        { status: 404 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "No file uploaded" },
        { status: 400 }
      );
    }

    console.log(
      `[knowledge] Received file: ${file.name}, ${file.size} bytes, ${file.type}`
    );

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          error: "File is too large. Maximum size is 10 MB.",
        },
        { status: 400 }
      );
    }

    const fileName = file.name;
    const lowerName = fileName.toLowerCase();

    const supported =
      lowerName.endsWith(".pdf") ||
      lowerName.endsWith(".docx") ||
      lowerName.endsWith(".txt");

    if (!supported) {
      return NextResponse.json(
        {
          error:
            "Unsupported file type. Please upload PDF, DOCX, or TXT.",
        },
        { status: 400 }
      );
    }

    const serviceSupabase = createServiceSupabase();

    /*
     * Create the document row first.
     *
     * knowledge_documents does NOT have created_at.
     */
    const { data: document, error: documentError } =
      await serviceSupabase
        .from("knowledge_documents")
        .insert({
          tenant_id: tenant.id,
          file_name: fileName,
          storage_path: "pending",
        })
        .select("id")
        .single();

    if (documentError || !document) {
      console.error(
        "[knowledge] Failed to create document:",
        documentError
      );

      return NextResponse.json(
        {
          error: "Failed to create knowledge document",
          details: documentError?.message ?? null,
        },
        { status: 500 }
      );
    }

    documentId = document.id;

    storagePath = `${tenant.id}/${document.id}/${fileName}`;

    /*
     * Upload original file to private Storage.
     */
    const { error: uploadError } = await serviceSupabase.storage
      .from("knowledge")
      .upload(storagePath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });

    if (uploadError) {
      console.error(
        "[knowledge] Storage upload failed:",
        uploadError
      );

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id)
        .eq("tenant_id", tenant.id);

      return NextResponse.json(
        {
          error: "Failed to upload file",
          details: uploadError.message,
        },
        { status: 500 }
      );
    }

    /*
     * Save the actual Storage path.
     */
    const { error: pathError } = await serviceSupabase
      .from("knowledge_documents")
      .update({
        storage_path: storagePath,
      })
      .eq("id", document.id)
      .eq("tenant_id", tenant.id);

    if (pathError) {
      console.error(
        "[knowledge] Failed to update storage path:",
        pathError
      );

      await serviceSupabase.storage
        .from("knowledge")
        .remove([storagePath]);

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id)
        .eq("tenant_id", tenant.id);

      return NextResponse.json(
        {
          error: "Failed to save document information",
          details: pathError.message,
        },
        { status: 500 }
      );
    }

    /*
     * Extract readable text.
     */
    let text: string;

    try {
      text = await extractText(file);
    } catch (error) {
      console.error(
        "[knowledge] Text extraction failed:",
        error
      );

      await serviceSupabase.storage
        .from("knowledge")
        .remove([storagePath]);

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id)
        .eq("tenant_id", tenant.id);

      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Could not read the uploaded file.",
        },
        { status: 400 }
      );
    }

    console.log(
      `[knowledge] Extracted ${text.length} characters from ${fileName}`
    );

    const chunks = chunkText(text);

    console.log(
      `[knowledge] Created ${chunks.length} chunks from ${fileName}`
    );

    if (chunks.length === 0) {
      await serviceSupabase.storage
        .from("knowledge")
        .remove([storagePath]);

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id)
        .eq("tenant_id", tenant.id);

      return NextResponse.json(
        {
          error:
            "The file did not contain readable text. Scanned/image-only PDFs are not supported yet.",
        },
        { status: 400 }
      );
    }

    /*
     * Generate embeddings.
     */
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    console.log(
      `[knowledge] Generating embeddings for ${chunks.length} chunks`
    );

    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunks,
    });

    if (embeddingResponse.data.length !== chunks.length) {
      throw new Error(
        "Embedding count did not match chunk count."
      );
    }

    const chunkRows = chunks.map((content, index) => ({
      tenant_id: tenant.id,
      document_id: document.id,
      content,
      embedding: embeddingResponse.data[index].embedding,
    }));

    /*
     * Store chunks and embeddings.
     */
    const { error: chunkError } = await serviceSupabase
      .from("knowledge_chunks")
      .insert(chunkRows);

    if (chunkError) {
      console.error(
        "[knowledge] Failed to insert chunks:",
        chunkError
      );

      await serviceSupabase.storage
        .from("knowledge")
        .remove([storagePath]);

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id)
        .eq("tenant_id", tenant.id);

      return NextResponse.json(
        {
          error: "Failed to index the document",
          details: chunkError.message,
        },
        { status: 500 }
      );
    }

    console.log(
      `[knowledge] Successfully indexed ${fileName}`
    );

    return NextResponse.json({
      success: true,
      documentId: document.id,
      fileName,
      chunksCreated: chunks.length,
    });
  } catch (error) {
    console.error("[knowledge] Upload error:", error);

    /*
     * Best-effort cleanup for unexpected errors.
     */
    try {
      const serviceSupabase = createServiceSupabase();

      if (storagePath) {
        await serviceSupabase.storage
          .from("knowledge")
          .remove([storagePath]);
      }

      if (documentId) {
        await serviceSupabase
          .from("knowledge_documents")
          .delete()
          .eq("id", documentId);
      }
    } catch (cleanupError) {
      console.error(
        "[knowledge] Cleanup after failure also failed:",
        cleanupError
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unexpected knowledge upload error",
      },
      { status: 500 }
    );
  }
}