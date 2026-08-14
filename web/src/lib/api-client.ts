// Browser-side helper for calling NoPM's REST API (same-origin, session cookie auth).
// Unwraps the { data } / { error, fields } contract.

export type ApiError = Error & { status?: number; fields?: { field: string; message: string }[] };

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: string;
    fields?: { field: string; message: string }[];
  };
  if (!res.ok) {
    const err = new Error(json.error || `Request failed (${res.status})`) as ApiError;
    err.status = res.status;
    err.fields = json.fields;
    throw err;
  }
  return json.data as T;
}

export const apiGet = <T = unknown>(path: string) => call<T>("GET", path);
export const apiPost = <T = unknown>(path: string, body?: unknown) => call<T>("POST", path, body);
export const apiPut = <T = unknown>(path: string, body?: unknown) => call<T>("PUT", path, body);
export const apiPatch = <T = unknown>(path: string, body?: unknown) => call<T>("PATCH", path, body);
export const apiDelete = <T = unknown>(path: string, body?: unknown) => call<T>("DELETE", path, body);
