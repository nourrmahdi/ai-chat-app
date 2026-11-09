import { saveDocument } from "@/lib/documents";
import { MAX_DOCUMENT_BYTES, documentMediaType, fileKind } from "@/lib/files";

// Receives a document (PDF, Word, Excel, CSV, code, text), extracts its text,
// splits it into chunks, creates embeddings, and stores everything in Vercel Blob.

export const maxDuration = 60; // large documents take time to parse and embed

export async function POST(req: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.OPENROUTER_API_KEY) {
    return Response.json({ error: "The server is missing its storage or API key." }, { status: 500 });
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "No file received." }, { status: 400 });
    }

    const kind = fileKind(file.name, file.type);
    if (!kind || kind === "image") {
      return Response.json({ error: "Unsupported file type." }, { status: 400 });
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      return Response.json({ error: "File is too large (max 4 MB)." }, { status: 413 });
    }

    const saved = await saveDocument(file, kind);

    return Response.json({
      ...saved,
      filename: file.name,
      mediaType: documentMediaType(kind, file.name),
      kind,
    });
  } catch (err) {
    console.error("Document error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
