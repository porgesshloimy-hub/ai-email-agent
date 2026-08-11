import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    id: string;
  };
}

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
     * Manual entries use manual/... and don't have a Storage object.
     */
    if (
      document.storage_path &&
      !document.storage_path.startsWith("manual/")
    ) {
      const { error: storageError } = await serviceSupabase.storage
        .from("knowledge")
        .remove([document.storage_path]);

      if (storageError) {
        console.error(
          "Failed to remove knowledge file:",
          storageError
        );
      }
    }

    /*
     * knowledge_chunks has ON DELETE CASCADE,
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
      { error: "Unexpected knowledge error" },
      { status: 500 }
    );
  }
}