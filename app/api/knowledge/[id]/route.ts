import { NextResponse } from "next/server";
import {
  createServerSupabase,
  createServiceSupabase,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    id: string;
  };
}

/**
 * GET /api/knowledge/[id]
 *
 * Returns a knowledge document and all of its readable content.
 */
export async function GET(
  request: Request,
  context: RouteContext
) {
  try {
    const supabase = await createServerSupabase();

    // ---------------------------------------------------------
    // 1. Authenticate the user
    // ---------------------------------------------------------

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

    // ---------------------------------------------------------
    // 2. Find the user's tenant
    // ---------------------------------------------------------

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("owner_user_id", user.id)
      .single();

    if (tenantError || !tenant) {
      console.error("Knowledge tenant lookup failed:", tenantError);

      return NextResponse.json(
        { error: "Tenant not found" },
        { status: 404 }
      );
    }

    const documentId = context.params.id;

    // ---------------------------------------------------------
    // 3. Use the service client for the knowledge tables
    // ---------------------------------------------------------

    const serviceSupabase = createServiceSupabase();

    // ---------------------------------------------------------
    // 4. Fetch the document
    //
    // IMPORTANT:
    // knowledge_documents does NOT have created_at.
    // The actual timestamp column is uploaded_at.
    // ---------------------------------------------------------

    const { data: document, error: documentError } =
      await serviceSupabase
        .from("knowledge_documents")
        .select(
          "id, tenant_id, file_name, storage_path, uploaded_at"
        )
        .eq("id", documentId)
        .eq("tenant_id", tenant.id)
        .single();

    if (documentError || !document) {
      console.error(
        "Knowledge document not found:",
        documentError
      );

      return NextResponse.json(
        {
          error: "Knowledge document not found",
          details: documentError?.message ?? null,
        },
        { status: 404 }
      );
    }

    // ---------------------------------------------------------
    // 5. Fetch the document's chunks
    //
    // The actual readable text lives here.
    // ---------------------------------------------------------

    const { data: chunks, error: chunksError } =
      await serviceSupabase
        .from("knowledge_chunks")
        .select("id, content")
        .eq("document_id", document.id)
        .eq("tenant_id", tenant.id)
        .order("created_at", { ascending: true });

    /*
     * Some databases may not have created_at on knowledge_chunks.
     * If that happens, retry without ordering by created_at.
     */
    let finalChunks = chunks;

    if (chunksError) {
      console.warn(
        "Knowledge chunks query with created_at ordering failed. Retrying without ordering:",
        chunksError
      );

      const { data: retryChunks, error: retryError } =
        await serviceSupabase
          .from("knowledge_chunks")
          .select("id, content")
          .eq("document_id", document.id)
          .eq("tenant_id", tenant.id);

      if (retryError) {
        console.error(
          "Failed to load knowledge chunks:",
          retryError
        );

        return NextResponse.json(
          {
            error: "Failed to load knowledge content",
            details: retryError.message,
          },
          { status: 500 }
        );
      }

      finalChunks = retryChunks;
    }

    // ---------------------------------------------------------
    // 6. Combine all readable chunks into the document content
    // ---------------------------------------------------------

    const readableChunks = (finalChunks ?? []).filter(
      (chunk) =>
        typeof chunk.content === "string" &&
        chunk.content.trim().length > 0
    );

    const content = readableChunks
      .map((chunk) => chunk.content.trim())
      .join("\n\n");

    // ---------------------------------------------------------
    // 7. Return the document
    // ---------------------------------------------------------

    return NextResponse.json({
      success: true,

      document: {
        id: document.id,
        file_name: document.file_name,
        storage_path: document.storage_path,
        uploaded_at: document.uploaded_at ?? null,

        chunk_count: readableChunks.length,

        content,

        chunks: readableChunks.map((chunk, index) => ({
          id: chunk.id,
          index: index + 1,
          content: chunk.content,
        })),
      },
    });
  } catch (error) {
    console.error("Knowledge details error:", error);

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

/**
 * DELETE /api/knowledge/[id]
 *
 * Deletes:
 * - the knowledge document
 * - its chunks/embeddings
 * - its Storage file when applicable
 */
export async function DELETE(
  request: Request,
  context: RouteContext
) {
  try {
    const supabase = await createServerSupabase();

    // ---------------------------------------------------------
    // 1. Authenticate
    // ---------------------------------------------------------

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

    // ---------------------------------------------------------
    // 2. Find tenant
    // ---------------------------------------------------------

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

    const documentId = context.params.id;

    const serviceSupabase = createServiceSupabase();

    // ---------------------------------------------------------
    // 3. Fetch document
    //
    // Again, do NOT request created_at.
    // ---------------------------------------------------------

    const { data: document, error: documentError } =
      await serviceSupabase
        .from("knowledge_documents")
        .select("id, storage_path")
        .eq("id", documentId)
        .eq("tenant_id", tenant.id)
        .single();

    if (documentError || !document) {
      return NextResponse.json(
        {
          error: "Knowledge document not found",
          details: documentError?.message ?? null,
        },
        { status: 404 }
      );
    }

    // ---------------------------------------------------------
    // 4. Remove Storage file when applicable
    // ---------------------------------------------------------

    if (
      document.storage_path &&
      !document.storage_path.startsWith("manual/")
    ) {
      const { error: storageError } =
        await serviceSupabase.storage
          .from("knowledge")
          .remove([document.storage_path]);

      if (storageError) {
        console.error(
          "Failed to remove knowledge file:",
          storageError
        );

        // Continue with database deletion.
      }
    }

    // ---------------------------------------------------------
    // 5. Delete the document
    //
    // knowledge_chunks should cascade if the FK is configured
    // with ON DELETE CASCADE.
    // ---------------------------------------------------------

    const { error: deleteError } =
      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", documentId)
        .eq("tenant_id", tenant.id);

    if (deleteError) {
      console.error(
        "Failed to delete knowledge document:",
        deleteError
      );

      return NextResponse.json(
        {
          error: "Failed to delete knowledge",
          details: deleteError.message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error("Knowledge delete error:", error);

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