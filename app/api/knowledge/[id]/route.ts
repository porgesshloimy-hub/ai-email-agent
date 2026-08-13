import { NextResponse } from "next/server";
import {
  createServerSupabase,
  createServiceSupabase,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

/**
 * GET /api/knowledge/[id]
 *
 * Returns the details and stored content of a knowledge document.
 */
export async function GET(
  request: Request,
  context: RouteContext
) {
  try {
    /*
     * Get the authenticated user.
     */
    const supabase = await createServerSupabase();

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      console.error(
        "Knowledge GET: user authentication failed:",
        userError
      );

      return NextResponse.json(
        {
          error: "Not authenticated",
        },
        { status: 401 }
      );
    }

    /*
     * IMPORTANT:
     * In current Next.js versions, route params are async.
     */
    const { id: documentId } = await context.params;

    if (!documentId) {
      console.error(
        "Knowledge GET: missing document ID"
      );

      return NextResponse.json(
        {
          error: "Knowledge document ID is required",
        },
        { status: 400 }
      );
    }

    console.log(
      "Knowledge GET:",
      {
        userId: user.id,
        documentId,
      }
    );

    /*
     * Find the authenticated user's tenant.
     */
    const { data: tenant, error: tenantError } =
      await supabase
        .from("tenants")
        .select("id")
        .eq("owner_user_id", user.id)
        .single();

    if (tenantError || !tenant) {
      console.error(
        "Knowledge GET: tenant not found:",
        {
          userId: user.id,
          tenantError,
        }
      );

      return NextResponse.json(
        {
          error: "Tenant not found",
        },
        { status: 404 }
      );
    }

    console.log(
      "Knowledge GET: resolved tenant:",
      tenant.id
    );

    /*
     * Use the service client for the tenant-scoped
     * document/chunk lookup.
     *
     * We explicitly filter by tenant_id so a user
     * cannot access another tenant's knowledge.
     */
    const serviceSupabase = createServiceSupabase();

    const {
      data: document,
      error: documentError,
    } = await serviceSupabase
      .from("knowledge_documents")
      .select(
        `
          id,
          tenant_id,
          file_name,
          storage_path,
          uploaded_at,
          created_at
        `
      )
      .eq("id", documentId)
      .eq("tenant_id", tenant.id)
      .maybeSingle();

    if (documentError) {
      console.error(
        "Knowledge GET: document query failed:",
        documentError
      );

      return NextResponse.json(
        {
          error: "Failed to load knowledge document",
          details: documentError.message,
        },
        { status: 500 }
      );
    }

    if (!document) {
      console.error(
        "Knowledge GET: document not found:",
        {
          documentId,
          tenantId: tenant.id,
        }
      );

      return NextResponse.json(
        {
          error: "Knowledge document not found",
          documentId,
        },
        { status: 404 }
      );
    }

    /*
     * Fetch the chunks belonging to this document.
     *
     * Do NOT return embeddings to the browser.
     */
    const {
      data: chunks,
      error: chunksError,
    } = await serviceSupabase
      .from("knowledge_chunks")
      .select("id, content")
      .eq("document_id", documentId)
      .eq("tenant_id", tenant.id)
      .order("id", { ascending: true });

    if (chunksError) {
      console.error(
        "Knowledge GET: chunk query failed:",
        chunksError
      );

      return NextResponse.json(
        {
          error: "Failed to load knowledge content",
          details: chunksError.message,
        },
        { status: 500 }
      );
    }

    const normalizedChunks =
      (chunks ?? []).map((chunk, index) => ({
        id: chunk.id,
        index: index + 1,
        content: chunk.content ?? "",
      }));

    /*
     * Combine chunks into readable content.
     */
    const content = normalizedChunks
      .map((chunk) => chunk.content)
      .join("\n\n");

    console.log(
      "Knowledge GET: success:",
      {
        documentId,
        tenantId: tenant.id,
        chunkCount: normalizedChunks.length,
      }
    );

    /*
     * IMPORTANT:
     *
     * The page expects:
     *
     * data.document
     * data.chunks
     *
     * So return chunks at the top level.
     */
    return NextResponse.json({
      success: true,

      document: {
        id: document.id,
        file_name: document.file_name,
        storage_path: document.storage_path,
        uploaded_at:
          document.uploaded_at ??
          document.created_at ??
          null,
        chunk_count: normalizedChunks.length,
      },

      chunks: normalizedChunks,

      content,
    });
  } catch (error) {
    console.error(
      "Knowledge GET unexpected error:",
      error
    );

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
    /*
     * Authenticate the user.
     */
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

    /*
     * Current Next.js route params are async.
     */
    const { id: documentId } = await context.params;

    if (!documentId) {
      return NextResponse.json(
        {
          error: "Knowledge document ID is required",
        },
        { status: 400 }
      );
    }

    /*
     * Find the user's tenant.
     */
    const { data: tenant, error: tenantError } =
      await supabase
        .from("tenants")
        .select("id")
        .eq("owner_user_id", user.id)
        .single();

    if (tenantError || !tenant) {
      return NextResponse.json(
        {
          error: "Tenant not found",
        },
        { status: 404 }
      );
    }

    const serviceSupabase = createServiceSupabase();

    /*
     * Get the document first so we can determine
     * whether there is an uploaded Storage file.
     */
    const {
      data: document,
      error: documentError,
    } = await serviceSupabase
      .from("knowledge_documents")
      .select(
        `
          id,
          tenant_id,
          storage_path
        `
      )
      .eq("id", documentId)
      .eq("tenant_id", tenant.id)
      .maybeSingle();

    if (documentError) {
      console.error(
        "Knowledge DELETE: document query failed:",
        documentError
      );

      return NextResponse.json(
        {
          error: "Failed to find knowledge document",
        },
        { status: 500 }
      );
    }

    if (!document) {
      return NextResponse.json(
        {
          error: "Knowledge document not found",
        },
        { status: 404 }
      );
    }

    /*
     * Remove the original uploaded file.
     *
     * Manual knowledge uses manual/... and therefore
     * does not have an actual Storage object.
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
        /*
         * Don't block database deletion just because
         * Storage cleanup failed.
         */
        console.error(
          "Knowledge DELETE: Storage cleanup failed:",
          storageError
        );
      }
    }

    /*
     * Delete the document.
     *
     * knowledge_chunks should have ON DELETE CASCADE,
     * so its chunks/embeddings are deleted as well.
     */
    const { error: deleteError } =
      await serviceSupabase
        .from("knowledge_documents")
        .delete()
        .eq("id", documentId)
        .eq("tenant_id", tenant.id);

    if (deleteError) {
      console.error(
        "Knowledge DELETE: database deletion failed:",
        deleteError
      );

      return NextResponse.json(
        {
          error: "Failed to delete knowledge",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error(
      "Knowledge DELETE unexpected error:",
      error
    );

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