"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, FileText } from "lucide-react";
import { Ackstack, AckstackError } from "@saas/sdk";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TARGETS } from "@/lib/api";
import type { AckLinkResponse, AckReceiptResponse } from "@saas/contracts/policies";

/**
 * The staff-facing page. Deliberately outside the (app) group: a member of
 * staff never has an account, and the link token in the URL is the whole
 * credential (risk AS-B). The console is pinned to one API target per
 * deployment, so the first target is the right one.
 */
export default function AckPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const target = TARGETS[0]!;
  const client = React.useMemo(() => new Ackstack({ baseUrl: target.url }), [target.url]);

  const [link, setLink] = React.useState<AckLinkResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [receipt, setReceipt] = React.useState<AckReceiptResponse["receipt"] | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    client.ack
      .get(token)
      .then((r) => live && setLink(r))
      .catch(() => live && setError("This link is not valid. It may have expired or been replaced by a newer one — ask your employer to resend it."));
    return () => {
      live = false;
    };
  }, [client, token]);

  const acknowledge = async () => {
    setBusy(true);
    try {
      const r = await client.ack.acknowledge(token);
      setReceipt(r.receipt);
    } catch (e) {
      if (e instanceof AckstackError && e.status === 409) {
        setError("This acknowledgment is already recorded.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const documentUrl = `${target.url.replace(/\/+$/, "")}/v1/ack/${encodeURIComponent(token)}/document`;
  const recordedAt = receipt?.acknowledgedAt ?? (link?.status === "acknowledged" ? link.acknowledgedAt : null);

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-4">
        {error && !link ? (
          <Card>
            <CardHeader>
              <CardTitle>Link not valid</CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
          </Card>
        ) : !link ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{link.policy.title}</CardTitle>
              <CardDescription>
                Version {link.version.version} · for {link.staff.fullName}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {link.version.summary && (
                <p className="text-sm">
                  <strong>Summary:</strong> {link.version.summary}
                </p>
              )}
              {link.version.hasDocument && (
                <a
                  href={documentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm underline"
                >
                  <FileText className="h-4 w-4" />
                  Read the policy{link.version.filename ? ` (${link.version.filename})` : ""}
                </a>
              )}
              {link.version.bodyMd && (
                <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border p-3 text-sm">
                  {link.version.bodyMd}
                </div>
              )}
              {recordedAt ? (
                <div className="flex items-start gap-2 rounded-md border border-green-600/40 p-3 text-sm">
                  <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                  <div>
                    Acknowledged version {link.version.version} on{" "}
                    {new Date(recordedAt).toLocaleString()}. You can close this page.
                  </div>
                </div>
              ) : (
                <>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <Button disabled={busy} onClick={acknowledge}>
                    I have read and acknowledge this policy
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
