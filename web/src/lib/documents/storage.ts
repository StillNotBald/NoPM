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
