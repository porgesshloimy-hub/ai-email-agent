import { NextResponse } from "next/server";
import {
  createServerSupabase,
  createServiceSupabase,
} from "@/lib/supabase/server";
import OpenAI from "openai";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

  if (name.endsWith(".txt")) {
    return buffer.toString("utf8");
  }

  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({
      buffer,
    });

    return result.value;
  }

  if (name.endsWith(".pdf")) {
    let parser: PDFParse | null = null;

    try {
      parser = new PDFParse({
        data: buffer,
      });

      const result = await parser.getText();

      return result.text || "";
    } finally {
      if (parser) {
        try {
          await parser.destroy();
        } catch (destroyError) {
          console.warn(
            "PDF parser cleanup failed:",
            destroyError
          );
        }
      }
    }
  }

  throw new Error(
    "Unsupported file type. Please upload a PDF, DOCX, or TXT file."
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error
  ) {
    return String(
      (error as { message?: unknown }).message
    );
  }

  return "Unknown error";
}

export async function POST(request: Request) {
  let serviceSupabase: ReturnType<typeof createServiceSupabase> | null =
    null;

  let documentId: string | null = null;
  let storagePath: string | null = null;

  try {
    // ---------------------------------------------------------
    // 1. Authenticate
    // ---------------------------------------------------------

    const supabase = await createServerSupabase();

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json(
        {
          error: "Not authenticated",
        },
        { status: 401 }
      );
    }

    // ---------------------------------------------------------
    // 2. Find tenant
    // ---------------------------------------------------------

    const { data: tenant, error: tenantError } =
      await supabase
        .from("tenants")
        .select("id")
        .eq("owner_user_id", user.id)
        .single();

    if (tenantError || !tenant) {
      console.error(
        "Knowledge upload tenant lookup failed:",
        tenantError
      );

      return NextResponse.json(
        {
          error: "Tenant not found",
          details: tenantError?.message ?? null,
        },
        { status: 404 }
      );
    }

    // ---------------------------------------------------------
    // 3. Read multipart form
    // ---------------------------------------------------------

    let formData: FormData;

    try {
      formData = await request.formData();
    } catch (error) {
      console.error(
        "Failed to parse upload form data:",
        error
      );

      return NextResponse.json(
        {
          error: "Could not read the uploaded file.",
          details: errorMessage(error),
        },
        { status: 400 }
      );
    }

    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        {
          error: "No file uploaded.",
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------
    // 4. Validate file
    // ---------------------------------------------------------

    if (file.size === 0) {
      return NextResponse.json(
        {
          error: "The uploaded file is empty.",
        },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          error:
            "File is too large. Maximum size is 10 MB.",
        },
        { status: 400 }
      );
    }

    const fileName = file.name.trim();

    const lowerName = fileName.toLowerCase();

    const isPdf = lowerName.endsWith(".pdf");
    const isDocx = lowerName.endsWith(".docx");
    const isTxt = lowerName.endsWith(".txt");

    if (!isPdf && !isDocx && !isTxt) {
      return NextResponse.json(
        {
          error:
            "Unsupported file type. Please upload PDF, DOCX, or TXT.",
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------
    // 5. Make sure required environment variables exist
    // ---------------------------------------------------------

    if (!process.env.OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is missing."
      );

      return NextResponse.json(
        {
          error:
            "OpenAI is not configured on the server.",
        },
        { status: 500 }
      );
    }

    // ---------------------------------------------------------
    // 6. Create service Supabase client
    // ---------------------------------------------------------

    serviceSupabase = createServiceSupabase();

    // ---------------------------------------------------------
    // 7. Create knowledge document
    //
    // IMPORTANT:
    // Your actual table contains:
    //
    // id
    // tenant_id
    // file_name
    // storage_path
    // uploaded_at
    //
    // There is NO created_at here.
    // ---------------------------------------------------------

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
        "Failed to create knowledge document:",
        documentError
      );

      return NextResponse.json(
        {
          error:
            "Failed to create knowledge document.",
          details: documentError?.message ?? null,
        },
        { status: 500 }
      );
    }

    documentId = document.id;

    // ---------------------------------------------------------
    // 8. Upload original file to Storage
    // ---------------------------------------------------------

    storagePath =
      `${tenant.id}/${document.id}/${fileName}`;

    const fileBuffer = Buffer.from(
      await file.arrayBuffer()
    );

    const { error: uploadError } =
      await serviceSupabase.storage
        .from("knowledge")
        .upload(storagePath, fileBuffer, {
          contentType:
            file.type ||
            (isPdf
              ? "application/pdf"
              : isDocx
                ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                : "text/plain"),
          upsert: false,
        });

    if (uploadError) {
      console.error(
        "Knowledge Storage upload failed:",
        uploadError
      );

      throw new Error(
        `Failed to upload file to Storage: ${uploadError.message}`
      );
    }

    // ---------------------------------------------------------
    // 9. Save actual Storage path
    // ---------------------------------------------------------

    const { error: pathError } =
      await serviceSupabase
        .from("knowledge_documents")
        .update({
          storage_path: storagePath,
        })
        .eq("id", document.id)
        .eq("tenant_id", tenant.id);

    if (pathError) {
      console.error(
        "Failed to save knowledge Storage path:",
        pathError
      );

      throw new Error(
        `Failed to save document information: ${pathError.message}`
      );
    }

    // ---------------------------------------------------------
    // 10. Extract readable text
    // ---------------------------------------------------------

    let text: string;

    try {
      text = await extractText(file);
    } catch (error) {
      console.error(
        "Knowledge text extraction failed:",
        error
      );

      throw new Error(
        `Could not read the uploaded ${isPdf ? "PDF" : isDocx ? "DOCX" : "TXT"}: ${errorMessage(error)}`
      );
    }

    // ---------------------------------------------------------
    // 11. Check that text was actually extracted
    // ---------------------------------------------------------

    const cleanedText = text.trim();

    if (!cleanedText) {
      throw new Error(
        isPdf
          ? "The PDF did not contain readable text. Scanned/image-only PDFs are not supported yet."
          : "The uploaded file did not contain readable text."
      );
    }

    // ---------------------------------------------------------
    // 12. Split text into chunks
    // ---------------------------------------------------------

    const chunks = chunkText(cleanedText);

    if (chunks.length === 0) {
      throw new Error(
        "No readable text could be created from this file."
      );
    }

    console.log(
      `Knowledge extraction successful: ${chunks.length} chunks`
    );

    // ---------------------------------------------------------
    // 13. Generate embeddings
    // ---------------------------------------------------------

    let embeddingResponse;

    try {
      embeddingResponse =
        await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: chunks,
        });
    } catch (error) {
      console.error(
        "Knowledge embedding generation failed:",
        error
      );

      throw new Error(
        `Failed to generate embeddings: ${errorMessage(error)}`
      );
    }

    if (
      !embeddingResponse.data ||
      embeddingResponse.data.length !== chunks.length
    ) {
      throw new Error(
        `Embedding count mismatch. Expected ${chunks.length}, received ${embeddingResponse.data?.length ?? 0}.`
      );
    }

    // ---------------------------------------------------------
    // 14. Build chunk rows
    // ---------------------------------------------------------

    const chunkRows = chunks.map(
      (content, index) => ({
        tenant_id: tenant.id,
        document_id: document.id,
        content,
        embedding:
          embeddingResponse.data[index].embedding,
      })
    );

    // ---------------------------------------------------------
    // 15. Insert chunks
    // ---------------------------------------------------------

    const { error: chunkError } =
      await serviceSupabase
        .from("knowledge_chunks")
        .insert(chunkRows);

    if (chunkError) {
      console.error(
        "Failed to insert knowledge chunks:",
        chunkError
      );

      throw new Error(
        `Failed to index the document: ${chunkError.message}`
      );
    }

    // ---------------------------------------------------------
    // 16. Success
    // ---------------------------------------------------------

    return NextResponse.json({
      success: true,
      documentId: document.id,
      fileName,
      chunksCreated: chunks.length,
    });
  } catch (error) {
    const message = errorMessage(error);

    console.error(
      "================================================="
    );
    console.error(
      "KNOWLEDGE UPLOAD FAILED"
    );
    console.error(
      "Document:",
      documentId
    );
    console.error(
      "Storage:",
      storagePath
    );
    console.error(
      "Error:",
      message
    );
    console.error(
      "================================================="
    );

    // ---------------------------------------------------------
    // Cleanup Storage
    // ---------------------------------------------------------

    if (
      serviceSupabase &&
      storagePath
    ) {
      try {
        await serviceSupabase.storage
          .from("knowledge")
          .remove([storagePath]);
      } catch (cleanupError) {
        console.error(
          "Storage cleanup failed:",
          cleanupError
        );
      }
    }

    // ---------------------------------------------------------
    // Cleanup database document
    //
    // If knowledge_chunks has ON DELETE CASCADE,
    // this also removes any chunks already inserted.
    // ---------------------------------------------------------

    if (
      serviceSupabase &&
      documentId
    ) {
      try {
        await serviceSupabase
          .from("knowledge_documents")
          .delete()
          .eq("id", documentId);
      } catch (cleanupError) {
        console.error(
          "Knowledge document cleanup failed:",
          cleanupError
        );
      }
    }

    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 }
    );
  }
}