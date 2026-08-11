import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
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

    const serviceSupabase = createServiceSupabase();

    const { data: documents, error } = await serviceSupabase
      .from("knowledge_documents")
      .select("id, file_name, storage_path, uploaded_at")
      .eq("tenant_id", tenant.id)
      .order("uploaded_at", { ascending: false });

    if (error) {
      console.error("Failed to load knowledge documents:", error);

      return NextResponse.json(
        { error: "Failed to load knowledge" },
        { status: 500 }
      );
    }

    const documentIds = (documents ?? []).map((document) => document.id);

    let chunkCounts: Record<string, number> = {};

    if (documentIds.length > 0) {
      const { data: chunks, error: chunkError } = await serviceSupabase
        .from("knowledge_chunks")
        .select("document_id")
        .eq("tenant_id", tenant.id)
        .in("document_id", documentIds);

      if (chunkError) {
        console.error("Failed to count knowledge chunks:", chunkError);

        return NextResponse.json(
          { error: "Failed to load knowledge chunks" },
          { status: 500 }
        );
      }

      chunkCounts = (chunks ?? []).reduce(
        (counts, chunk) => {
          counts[chunk.document_id] =
            (counts[chunk.document_id] ?? 0) + 1;

          return counts;
        },
        {} as Record<string, number>
      );
    }

    return NextResponse.json({
      documents: (documents ?? []).map((document) => ({
        ...document,
        chunk_count: chunkCounts[document.id] ?? 0,
      })),
    });
  } catch (error) {
    console.error("Knowledge list error:", error);

    return NextResponse.json(
      { error: "Unexpected knowledge error" },
      { status: 500 }
    );
  }
}