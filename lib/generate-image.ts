import { put } from "@vercel/blob";
import { IMAGE_MODEL } from "@/lib/models";

// Server-only: calls the image model on OpenRouter, then saves the result to Vercel Blob.

export type GenerateImageInput = {
  prompt: string;
  referenceImageUrls?: string[];
  aspectRatio?: string;
};

export type GenerateImageOutput = {
  url: string;
  downloadUrl: string;
  prompt: string;
  model: string;
  usedReferences: number;
};

// Only images from our own Blob storage can be used as references
const BLOB_HOST = /\.public\.blob\.vercel-storage\.com$/;

// Downloads a reference image and turns it into base64 (more reliable than sending a URL)
async function toDataUrl(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !BLOB_HOST.test(parsed.hostname)) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "image/png";
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    return `data:${type};base64,${base64}`;

  } catch {
    return null;
  }
}

// One call to the image model. Returns the image, or the model's text if it didn't draw anything.
async function callImageModel(content: object[], aspectRatio?: string) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: IMAGE_MODEL.id,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"], // ask for an image back, not just text
      ...(aspectRatio ? { image_config: { aspect_ratio: aspectRatio } } : {}),
    }),
  });

  if (!res.ok) {
    const details = await res.text();
    if (res.status === 429) throw new Error("The image model is rate-limited. Please try again in a moment.");
    throw new Error(`The image model returned an error (${res.status}): ${details.slice(0, 200)}`);
  }

  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  const imageUrl: string | undefined = message?.images?.[0]?.image_url?.url;
  const text: string = typeof message?.content === "string" ? message.content : "";
  return { imageUrl, text };

}

export async function generateAndStoreImage({
  prompt,
  referenceImageUrls = [],
  aspectRatio,
}: GenerateImageInput): Promise<GenerateImageOutput> {
  // Turn reference images into base64 so the image model can always read them
  const references = (await Promise.all(referenceImageUrls.slice(0, 3).map(toDataUrl))).filter(
    (r): r is string => r !== null
  );

  // Clear instructions help the image model return a picture instead of text
  const instruction = references.length
    ? `Edit or transform the attached image${references.length > 1 ? "s" : ""} as described below, and return one new image. ${prompt}`
    : `Generate one image: ${prompt}`;

  // Multi-part content: the text instruction plus any reference images
  const content = [
    { type: "text", text: instruction },
    ...references.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  // Image models sometimes answer with text only, so try twice
  let result = await callImageModel(content, aspectRatio);
  if (!result.imageUrl) result = await callImageModel(content, aspectRatio);
  if (!result.imageUrl) {
    const reason = result.text ? ` It said: "${result.text.slice(0, 150)}"` : "";
    throw new Error(`The image model didn't return an image.${reason}`);
  }

  // The model usually returns a base64 data URL: "data:image/png;base64,...."

  let bytes: Buffer;
  let contentType = "image/png";
  const match = result.imageUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (match) {
    contentType = match[1];
    bytes = Buffer.from(match[2], "base64");
  } else {
    const download = await fetch(result.imageUrl);
    contentType = download.headers.get("content-type") ?? contentType;
    bytes = Buffer.from(await download.arrayBuffer());
  }

  const extension = contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const blob = await put(`generated/image.${extension}`, bytes, {
    access: "public",
    addRandomSuffix: true,
    contentType,
  });

  return {
    url: blob.url,
    downloadUrl: blob.downloadUrl,
    prompt,
    model: IMAGE_MODEL.name,
    usedReferences: references.length,
  };
}