import { put } from "@vercel/blob";

// Receives one image from the browser and stores it in Vercel Blob.
// Returns a public URL that the chat (and the AI models) can use.

const MAX_BYTES = 4 * 1024 * 1024; // Vercel limits request bodies to ~4.5 MB
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export async function POST(req: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json({ error: "Image storage is not configured on the server." }, { status: 500 });
  }

  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return Response.json({ error: "No file received." }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return Response.json({ error: "Only PNG, JPEG, WebP or GIF images are supported." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return Response.json({ error: "Image is too large (max 4 MB)." }, { status: 413 });
    }

    const safeName = file.name.replace(/[^\w.-]/g, "_") || "image";
    const blob = await put(`uploads/${safeName}`, file, {
      access: "public",
      addRandomSuffix: true,
      contentType: file.type,

    });

    return Response.json({ url: blob.url, mediaType: file.type, filename: file.name });
  } catch (err) {
    console.error("Upload error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: `Storage error: ${message}` }, { status: 500 });
  }
}