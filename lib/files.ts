// Shared by the browser and the server: which files are accepted and how they're grouped.

export type FileKind = "image" | "pdf" | "docx" | "spreadsheet" | "code" | "text";

const CODE_EXTENSIONS = [
  "js", "jsx", "ts", "tsx", "py", "java", "c", "h", "cpp", "hpp", "cs", "go", "rs", "rb", "php",
  "swift", "kt", "m", "r", "sql", "sh", "ps1", "html", "css", "scss", "json", "xml", "yaml", "yml", "toml",
];
const TEXT_EXTENSIONS = ["txt", "md", "markdown", "log", "ini", "env.example"];

export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024; // Vercel Hobby limits request bodies to ~4.5 MB

export function extensionOf(filename: string) {
  return filename.toLowerCase().split(".").pop() ?? "";
}

export function fileKind(filename: string, mediaType = ""): FileKind | null {
  const ext = extensionOf(filename);
  if (mediaType.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (ext === "pdf" || mediaType === "application/pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (["xlsx", "csv"].includes(ext)) return "spreadsheet";
  if (CODE_EXTENSIONS.includes(ext)) return "code";
  if (TEXT_EXTENSIONS.includes(ext) || mediaType.startsWith("text/")) return "text";
  return null;
}

// Value for the file picker's "accept" attribute
export const ACCEPTED_FILES = [
  "image/png", "image/jpeg", "image/webp", "image/gif",
  ".pdf", ".docx", ".xlsx", ".csv",
  ...CODE_EXTENSIONS.map((e) => `.${e}`),
  ...TEXT_EXTENSIONS.map((e) => `.${e}`),
].join(",");

// A media type we store for documents, so the chat knows the file is a document and not an image
export function documentMediaType(kind: FileKind, filename: string) {
  switch (kind) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "spreadsheet":
      return extensionOf(filename) === "csv"
        ? "text/csv"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return "text/plain";
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
