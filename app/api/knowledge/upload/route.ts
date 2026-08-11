import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import OpenAI from "openai";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

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

  if (!cleaned) return [];

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

    if ((current + "\n\n" + paragraph).length <= maxChars) {
      current += "\n\n" + paragraph;
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

  if (name.endsWith(".txt")) {
    return buffer.toString("utf8");
  }

  if (name.endsWith(".pdf")) {
  const parser = new PDFParse({
    data: buffer,
  });

  const result = await parser.getText();

  await parser.destroy();

  return result.text;
}

  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({
      buffer,
    });

    return result.value;
  }

  throw new Error(
    "Unsupported file type. Please upload a PDF, DOCX, or TXT file."
  );
}

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabase();

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
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

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File is too large. Maximum size is 10 MB." },
        { status: 400 }
      );
    }

    const fileName = file.name;

    const supported =
      fileName.toLowerCase().endsWith(".pdf") ||
      fileName.toLowerCase().endsWith(".docx") ||
      fileName.toLowerCase().endsWith(".txt");

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
     * Create the document row first so we have its UUID
     * for both Storage and knowledge_chunks.
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
      console.error("Failed to create knowledge document:", documentError);

      return NextResponse.json(
        { error: "Failed to create knowledge document" },
        { status: 500 }
      );
    }

    const storagePath = `${tenant.id}/${document.id}/${fileName}`;

    /*
     * Upload original file to private Supabase Storage.
     */
    const { error: uploadError } = await serviceSupabase.storage
      .from("knowledge")
      .upload(storagePath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });

    if (uploadError) {
      console.error("Knowledge file upload failed:", uploadError);

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id);

      return NextResponse.json(
        { error: "Failed to upload file" },
        { status: 500 }
      );
    }

    /*
     * Update the document with the real Storage path.
     */
    const { error: pathError } = await serviceSupabase
      .from("knowledge_documents")
      .update({
        storage_path: storagePath,
      })
      .eq("id", document.id)
      .eq("tenant_id", tenant.id);

    if (pathError) {
      console.error("Failed to update storage path:", pathError);

      await serviceSupabase.storage
        .from("knowledge")
        .remove([storagePath]);

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id);

      return NextResponse.json(
        { error: "Failed to save document information" },
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
      console.error("Text extraction failed:", error);

      await serviceSupabase.storage
        .from("knowledge")
        .remove([storagePath]);

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id);

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

    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await serviceSupabase.storage
        .from("knowledge")
        .remove([storagePath]);

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id);

      return NextResponse.json(
        {
          error:
            "The file did not contain readable text. Scanned/image-only PDFs are not supported yet.",
        },
        { status: 400 }
      );
    }

    /*
     * Generate embeddings in one OpenAI request.
     */
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunks,
    });

    if (embeddingResponse.data.length !== chunks.length) {
      throw new Error("Embedding count did not match chunk count.");
    }

    const chunkRows = chunks.map((content, index) => ({
      tenant_id: tenant.id,
      document_id: document.id,
      content,
      embedding: embeddingResponse.data[index].embedding,
    }));

    /*
     * Insert the chunks and embeddings.
     */
    const { error: chunkError } = await serviceSupabase
      .from("knowledge_chunks")
      .insert(chunkRows);

    if (chunkError) {
      console.error("Failed to insert knowledge chunks:", chunkError);

      await serviceSupabase.storage
        .from("knowledge")
        .remove([storagePath]);

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id);

      return NextResponse.json(
        { error: "Failed to index the document" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      documentId: document.id,
      fileName,
      chunksCreated: chunks.length,
    });
  } catch (error) {
    console.error("Knowledge upload error:", error);

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