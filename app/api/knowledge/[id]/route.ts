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
 * Returns the details and content of a knowledge document.
 */
export async function GET(
  request: Request,
  context: RouteContext
) {
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

    /*
     * Find the authenticated user's tenant.
     */
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

    /*
     * Fetch the document.
     *
     * The tenant_id check is important so a user cannot
     * access another tenant's knowledge.
     */
    const { data: document, error: documentError } =
      await serviceSupabase
        .from("knowledge_documents")
        .select(
          "id, tenant_id, file_name, storage_path, uploaded_at, created_at"
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
        { error: "Knowledge document not found" },
        { status: 404 }
      );
    }

    /*
     * Fetch all chunks belonging to this document.
     *
     * We deliberately do NOT return the embedding itself.
     * The embedding is only used for semantic search and
     * does not need to be exposed to the browser.
     */
    const { data: chunks, error: chunksError } =
      await serviceSupabase
        .from("knowledge_chunks")
        .select("id, content")
        .eq("document_id", documentId)
        .eq("tenant_id", tenant.id)
        .order("id", { ascending: true });

    if (chunksError) {
      console.error(
        "Failed to load knowledge chunks:",
        chunksError
      );

      return NextResponse.json(
        { error: "Failed to load knowledge content" },
        { status: 500 }
      );
    }

    /*
     * Combine the chunks back into readable content.
     *
     * The chunks are separated by blank lines so the
     * original knowledge is easy to read in the UI.
     */
    const content = (chunks ?? [])
      .map((chunk) => chunk.content)
      .join("\n\n");

    return NextResponse.json({
      success: true,
      document: {
        id: document.id,
        file_name: document.file_name,
        storage_path: document.storage_path,
        uploaded_at:
          document.uploaded_at ?? document.created_at ?? null,
        chunk_count: chunks?.length ?? 0,
        content,
        chunks:
          chunks?.map((chunk, index) => ({
            id: chunk.id,
            index: index + 1,
            content: chunk.content,
          })) ?? [],
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
 * Deletes the knowledge document, its chunks/embeddings,
 * and its original Storage file if applicable.
 */
export async function DELETE(
  request: Request,
  context: RouteContext
) {
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

    /*
     * Find the authenticated user's tenant.
     */
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

    /*
     * Fetch the document first so we know its Storage path.
     *
     * The tenant_id check is critical for tenant isolation.
     */
    const { data: document, error: documentError } =
      await serviceSupabase
        .from("knowledge_documents")
        .select("id, storage_path")
        .eq("id", documentId)
        .eq("tenant_id", tenant.id)
        .single();

    if (documentError || !document) {
      return NextResponse.json(
        { error: "Knowledge document not found" },
        { status: 404 }
      );
    }

    /*
     * Remove the original file if this was a real uploaded file.
     *
     * Manual entries use manual/... and don't have a Storage object.
     */
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

        /*
         * We continue with database deletion.
         *
         * Otherwise a Storage problem could leave the user's
         * knowledge permanently stuck in the dashboard.
         */
      }
    }

    /*
     * knowledge_chunks should have ON DELETE CASCADE,
     * so deleting the document also deletes its embeddings.
     */
    const { error: deleteError } = await serviceSupabase
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
        { error: "Failed to delete knowledge" },
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