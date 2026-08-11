import { NextResponse } from "next/server";
import { createServerSupabase,createServiceSupabase } from "@/lib/supabase/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

    const body = await request.json();

    const title =
      typeof body.title === "string" ? body.title.trim() : "";

    const content =
      typeof body.content === "string" ? body.content.trim() : "";

    if (!title) {
      return NextResponse.json(
        { error: "A title is required." },
        { status: 400 }
      );
    }

    if (!content) {
      return NextResponse.json(
        { error: "Knowledge content is required." },
        { status: 400 }
      );
    }

    if (content.length > 100_000) {
      return NextResponse.json(
        { error: "Knowledge entry is too long." },
        { status: 400 }
      );
    }

    const chunks = chunkText(content);

    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "No readable content was provided." },
        { status: 400 }
      );
    }

    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunks,
    });

    if (embeddingResponse.data.length !== chunks.length) {
      throw new Error("Embedding count did not match chunk count.");
    }

    const serviceSupabase = createServiceSupabase();

    const { data: document, error: documentError } =
      await serviceSupabase
        .from("knowledge_documents")
        .insert({
          tenant_id: tenant.id,
          file_name: title,
          storage_path: `manual/${tenant.id}`,
        })
        .select("id")
        .single();

    if (documentError || !document) {
      console.error(
        "Failed to create manual knowledge document:",
        documentError
      );

      return NextResponse.json(
        { error: "Failed to create knowledge entry." },
        { status: 500 }
      );
    }

    const chunkRows = chunks.map((chunk, index) => ({
      tenant_id: tenant.id,
      document_id: document.id,
      content: chunk,
      embedding: embeddingResponse.data[index].embedding,
    }));

    const { error: chunkError } = await serviceSupabase
      .from("knowledge_chunks")
      .insert(chunkRows);

    if (chunkError) {
      console.error(
        "Failed to insert manual knowledge chunks:",
        chunkError
      );

      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", document.id);

      return NextResponse.json(
        { error: "Failed to save knowledge entry." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      documentId: document.id,
      title,
      chunksCreated: chunks.length,
    });
  } catch (error) {
    console.error("Manual knowledge error:", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unexpected knowledge error",
      },
      { status: 500 }
    );
  }
}