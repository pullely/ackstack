import type { ApiTarget } from "./api";

/**
 * Download a CSV export. The SDK transport decodes JSON envelopes, and an
 * export is `text/csv`, so this is the one place the console fetches a route
 * directly — with the same bearer token the SDK would send.
 */
export async function downloadCsv(target: ApiTarget, token: string | null, path: string): Promise<boolean> {
  const res = await fetch(`${target.url.replace(/\/+$/, "")}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return false;
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = match?.[1] ?? "acknowledgments.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
