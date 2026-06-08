"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// ── Helpers ───────────────────────────────────────────────────────────────────

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type UploadStep = "idle" | "signing" | "uploading" | "recording" | "done";

export interface FileUploadProps {
  documentId: string;
  onSuccess?: () => void;
}

// ── FileUpload ────────────────────────────────────────────────────────────────

export function FileUpload({ documentId, onSuccess }: FileUploadProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<UploadStep>("idle");
  const [progress, setProgress] = useState(0); // 0-100 during upload
  const [error, setError] = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);

    // Client-side size guard
    if (file.size > MAX_BYTES) {
      setError(`File exceeds the 25 MB limit (${humanSize(file.size)}).`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    try {
      // ── Step 1: get a signed upload URL ──────────────────────────────────
      setStep("signing");
      const signRes = await fetch(`/api/documents/${documentId}/file/sign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          file_size: file.size,
        }),
      });

      if (!signRes.ok) {
        const j = (await signRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Sign failed (${signRes.status})`);
      }

      const signJson = (await signRes.json()) as {
        data: { signedUrl: string; token: string; path: string };
      };
      const { signedUrl, token, path } = signJson.data;

      // ── Step 2: upload the bytes to Storage ───────────────────────────────
      setStep("uploading");
      setProgress(0);

      // Upload bytes via Supabase browser client (uploadToSignedUrl).
      // Falls back to a raw PUT if the method is somehow unavailable.
      const supabase = createClient();
      const storageApi = supabase.storage.from("documents");

      if (typeof (storageApi as unknown as Record<string, unknown>).uploadToSignedUrl === "function") {
        type UploadFn = (
          path: string,
          token: string,
          file: File,
          opts?: { onUploadProgress?: (p: { loaded: number; total: number }) => void },
        ) => Promise<{ error: { message: string } | null }>;

        const upload = (storageApi as unknown as { uploadToSignedUrl: UploadFn }).uploadToSignedUrl;
        const { error: upErr } = await upload(path, token, file, {
          onUploadProgress: ({ loaded, total }) => {
            setProgress(Math.round((loaded / total) * 100));
          },
        });
        if (upErr) throw new Error(upErr.message);
        setProgress(100);
      } else {
        // Fallback: raw PUT to the signed URL (no progress)
        const putRes = await fetch(signedUrl, {
          method: "PUT",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);
        setProgress(100);
      }

      // ── Step 3: record the metadata on the document row ───────────────────
      setStep("recording");
      const recordRes = await fetch(`/api/documents/${documentId}/file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          file_size: file.size,
        }),
      });

      if (!recordRes.ok) {
        const j = (await recordRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Record failed (${recordRes.status})`);
      }

      // ── Step 4: refresh ───────────────────────────────────────────────────
      setStep("done");
      router.refresh();
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
      setStep("idle");
      setProgress(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const busy = step !== "idle" && step !== "done";

  return (
    <div className="flex flex-col gap-2">
      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        onChange={handleFileChange}
        disabled={busy}
        aria-label="Choose file to attach"
      />

      {/* Trigger button */}
      {!busy && step !== "done" && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => inputRef.current?.click()}
          className="self-start text-xs"
        >
          Attach file
        </Button>
      )}

      {/* Progress state */}
      {busy && (
        <div className="flex items-center gap-2 text-xs text-ink-secondary">
          <Spinner size="sm" />
          {step === "signing" && "Preparing upload…"}
          {step === "uploading" && (
            <span>
              Uploading{progress > 0 ? ` ${progress}%` : "…"}
            </span>
          )}
          {step === "recording" && "Saving…"}
        </div>
      )}

      {/* Progress bar (only while uploading) */}
      {step === "uploading" && progress > 0 && (
        <div className="h-1 w-full rounded-full bg-sunken overflow-hidden">
          <div
            className="h-full rounded-full bg-accent transition-all duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-xs text-danger">{error}</p>
      )}

      <p className="text-[11px] text-ink-muted">Max 25 MB. PDF, images, or any file type.</p>
    </div>
  );
}
