-- NoPM · 0065 documents_bucket_limit (2026-10-17) — A1-16.
--
-- The 25 MiB cap was only checked against the size the client DECLARED. The
-- bucket itself now enforces it, so an oversized upload to a signed URL is
-- refused by Storage whatever the browser claimed. Idempotent. The app places no
-- MIME allow-list on documents (any type may be attached; browser-executable
-- types are coerced to octet-stream and served as downloads), so none is set here.
-- 26214400 bytes = 25 MiB = MAX_FILE_SIZE in lib/documents/storage.ts.

update storage.buckets
   set file_size_limit = 26214400
 where id = 'documents';
