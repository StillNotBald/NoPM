/**
 * Storage helpers for document file attachments.
 * Bytes live in the private "documents" bucket; all access is via signed URLs
 * minted server-side by the service-role admin client.
 */

const BUCKET = "documents";
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MiB

/**
 * Strip path separators and keep only safe characters so no user-supplied
 * file name can escape the intended bucket prefix.
 * Allowed: ASCII letters, digits, dot, dash, underscore.
 */
export function sanitizeFileName(raw: string): string {
  return raw
    .replace(/[/\\]/g, "_")
    .replace(/[^a-zA-Z0-9.\-_]/g, "_")
    .slice(0, 200); // reasonable upper bound
}

/**
 * Canonical storage path: <workspaceId>/<documentId>/<sanitizedFileName>
 * This is what goes into the documents.storage_path column.
 */
export function buildStoragePath(
  workspaceId: string,
  documentId: string,
  fileName: string,
): string {
  return `${workspaceId}/${documentId}/${sanitizeFileName(fileName)}`;
}

/**
 * Confirm that a client-supplied path truly belongs to the expected document.
 * Prevents a caller from attaching an object from another workspace/document.
 */
export function validateStoragePath(
  path: string,
  workspaceId: string,
  documentId: string,
): boolean {
  return path.startsWith(`${workspaceId}/${documentId}/`);
}

export { BUCKET, MAX_FILE_SIZE };

/**
 * Types the console renders INLINE (PDF in an iframe, images in <img>).
 * Everything else is served as a download (Content-Disposition: attachment),
 * so a mislabeled file can never render inside the trusted viewer chrome.
 */
export const INLINE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Browser-executable types are never stored under their own label. */
const EXECUTABLE_MIME =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/javascript|application\/(x-)?javascript|application\/ecmascript|text\/xml|application\/xml)$/;

const MIME_SHAPE = /^[a-z0-9][a-z0-9!#export { BUCKET, MAX_FILE_SIZE };^_.+-]{0,126}\/[a-z0-9][a-z0-9!#export { BUCKET, MAX_FILE_SIZE };^_.+-]{0,126}$/;

/**
 * Normalize a client-declared MIME type: lower-case, strip parameters, and
 * coerce anything malformed or browser-executable to application/octet-stream.
 */
export function normalizeMimeType(raw: string): string {
  const mime = (raw ?? "").split(";")[0].trim().toLowerCase();
  if (!MIME_SHAPE.test(mime)) return "application/octet-stream";
  if (EXECUTABLE_MIME.test(mime)) return "application/octet-stream";
  return mime;
}

function startsWith(head: Uint8Array, sig: number[], offset = 0): boolean {
  if (head.length < offset + sig.length) return false;
  return sig.every((b, i) => head[offset + i] === b);
}

/**
 * Check the declared inline-rendered type against the file's leading bytes.
 * Returns true for non-inline types (nothing to spoof) and for consistent
 * inline types; false when the bytes contradict the label.
 */
export function matchesMagicBytes(mime: string, head: Uint8Array): boolean {
  switch (mime) {
    case "application/pdf": {
      // The PDF header may be preceded by up to 1024 bytes of junk (ISO 32000).
      const sig = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
      const limit = Math.min(head.length - sig.length, 1024);
      for (let i = 0; i <= limit; i++) if (startsWith(head, sig, i)) return true;
      return false;
    }
    case "image/png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(head, [0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8);
    default:
      return !INLINE_MIME_TYPES.has(mime);
  }
}

