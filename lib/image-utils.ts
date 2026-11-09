// Browser-only helpers for preparing images and documents before upload.

const MAX_SIDE = 1600; // longest side in pixels
const RESIZE_ABOVE_BYTES = 1.5 * 1024 * 1024;

// Shrinks large photos so uploads stay fast and under the 4 MB server limit
export async function shrinkImage(file: File): Promise<File> {
  if (file.type === "image/gif") return file; // keep animations as-is

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= RESIZE_ABOVE_BYTES) {
    bitmap.close();
    return file;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) return file;
  const name = file.name.replace(/\.\w+$/, "") + ".jpg";
  return new File([blob], name, { type: "image/jpeg" });
}

export type UploadedImage = { url: string; mediaType: string; filename: string };

// Sends one image to our /api/upload route, which stores it in Vercel Blob
export async function uploadImage(file: File): Promise<UploadedImage> {
  const prepared = await shrinkImage(file);
  const form = new FormData();
  form.append("file", prepared);

  const res = await fetch("/api/upload", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Upload failed.");
  return data as UploadedImage;
}

export type UploadedDocument = {
  url: string;
  mediaType: string;
  filename: string;
  chars: number;
  pages?: number;
  chunks: number;
  truncated: boolean;
  embedded: boolean;
  vectorStore?: "pgvector" | "blob" | "none";
};

// Sends one document to our /api/files route, which parses, indexes and stores it
export async function uploadDocument(file: File): Promise<UploadedDocument> {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch("/api/files", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Upload failed.");
  return data as UploadedDocument;
}
