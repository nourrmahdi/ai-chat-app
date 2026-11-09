import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only: stores document embeddings in Supabase (Postgres + pgvector) and searches them.
// If Supabase isn't configured, the app falls back to the vectors saved in Vercel Blob.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

let client: SupabaseClient | null = null;

export function vectorStoreEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

function db() {
  if (!vectorStoreEnabled()) throw new Error("Supabase is not configured.");
  client ??= createClient(SUPABASE_URL!, SUPABASE_KEY!, { auth: { persistSession: false } });
  return client;
}

// pgvector reads vectors written as text: "[0.1,0.2,...]"
const toVector = (v: number[]) => JSON.stringify(v);

// Saves every chunk of a document with its embedding (one row per chunk)
export async function storeChunks(documentUrl: string, documentName: string, chunks: string[], vectors: number[][]) {
  const rows = chunks.map((content, i) => ({
    document_url: documentUrl,
    document_name: documentName,
    chunk_index: i,
    content,
    embedding: toVector(vectors[i]),
  }));
  // Insert in batches so large documents don't hit request size limits
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db().from("document_chunks").insert(rows.slice(i, i + 200));
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  }
}

export type MatchedChunk = {
  document_url: string;
  document_name: string;
  chunk_index: number;
  content: string;
  similarity: number;
};

// Hybrid search in one document: meaning (pgvector cosine similarity) + exact words (Postgres full-text search)
export async function matchChunks(
  queryVector: number[],
  queryText: string,
  documentUrl: string,
  topK: number
): Promise<MatchedChunk[]> {
  const { data, error } = await db().rpc("match_document_chunks", {
    query_embedding: toVector(queryVector),
    query_text: queryText,
    document_urls: [documentUrl],
    match_count: topK,
  });
  if (error) throw new Error(`Supabase search failed: ${error.message}`);
  return (data ?? []) as MatchedChunk[];
}
