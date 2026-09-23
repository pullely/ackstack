"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { z } from "zod";
import { Plus, FileText, Upload, CheckCircle2 } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ZodForm } from "@/components/ui/zod-form";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { downloadCsv } from "@/lib/csv-download";
import type {
  CreatePolicyRequest,
  PublicPolicy,
  PublicPolicyVersion,
} from "@saas/contracts/policies";
import { POLICY_CATEGORIES } from "@saas/contracts/policies";

const schema = z.object({
  title: z.string().min(2).max(200),
  slug: z
    .string()
    .regex(/^[a-z0-9-]*$/, "lowercase, digits, hyphens")
    .max(64)
    .optional(),
  category: z.enum(POLICY_CATEGORIES).optional(),
});

const CATEGORY_LABELS: Record<string, string> = {
  handbook: "Handbook",
  harassment: "Anti-harassment",
  workplace_violence: "Workplace violence",
  safety: "Safety",
  other: "Other",
};

export default function PoliciesPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const key = qk.policies(orgId);
  const policies = useApiQuery(key, () =>
    wrap(async () => (await client.policies.list(orgId)).policies),
  );
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<PublicPolicy | null>(null);

  const items = policies.data ?? [];

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Policies</h1>
          <p className="text-sm text-muted-foreground">
            The register. Every version is frozen once published, so an acknowledgment always names
            exactly what was read.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-1.5" />
              New policy
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create policy</DialogTitle>
              <DialogDescription>
                A policy holds a version history. Nothing is sent to staff until a version is
                published and assigned.
              </DialogDescription>
            </DialogHeader>
            <ZodForm
              schema={schema}
              defaultValues={{ title: "", slug: "", category: "other" }}
              fields={[
                { name: "title", label: "Title", placeholder: "Anti-harassment policy" },
                {
                  name: "slug",
                  label: "Slug",
                  placeholder: "anti-harassment-policy",
                  hint: "Auto-filled from the title; edit to override.",
                },
                {
                  name: "category",
                  label: "Category",
                  hint: "Drives which state re-collection clock applies.",
                },
              ]}
              deriveSlug={{ from: "title", to: "slug" }}
              submitLabel="Create"
              cancel={{ label: "Cancel", onClick: () => setOpen(false) }}
              onSubmit={async (v) => {
                const payload: CreatePolicyRequest = { title: v.title };
                if (v.slug) payload.slug = v.slug;
                if (v.category) payload.category = v.category;
                const r = await wrap(async () => (await client.policies.create(orgId, payload)).policy);
                if (!r.ok) {
                  toast({ kind: "error", title: "Create failed", description: r.error.message });
                  return;
                }
                toast({ kind: "success", title: "Policy created" });
                setOpen(false);
                policies.reload();
              }}
            />
          </DialogContent>
        </Dialog>
      </header>

      {policies.loading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24 mt-2" />
              </CardHeader>
            </Card>
          ))}
        </div>
      ) : policies.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{policies.error.code}</CardTitle>
            <CardDescription>{policies.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No policies yet"
          description="Add the handbook, the anti-harassment policy, the workplace-violence policy — whatever staff have to acknowledge."
          primaryAction={{ label: "New policy", onClick: () => setOpen(true) }}
        />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((p) => (
            <Card
              key={p.id}
              className="h-full cursor-pointer transition-shadow hover:shadow-md hover:border-primary/40"
              onClick={() => setSelected(p)}
            >
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base truncate">{p.title}</CardTitle>
                  <Badge variant={p.status === "active" ? "success" : "secondary"}>{p.status}</Badge>
                </div>
                <CardDescription className="text-xs">
                  {CATEGORY_LABELS[p.category] ?? p.category}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-xs text-muted-foreground">
                  {p.currentVersionId ? "Published" : "No published version yet"}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <VersionsDialog
          orgId={orgId}
          policy={selected}
          onClose={() => setSelected(null)}
          onChanged={() => policies.reload()}
        />
      )}
    </div>
  );
}

/**
 * Publishing is three steps, and the dialog shows them as three, because
 * hiding the upload inside "save" is how you end up with a published version
 * whose document never arrived.
 */
function VersionsDialog({
  orgId,
  policy,
  onClose,
  onChanged,
}: {
  orgId: string;
  policy: PublicPolicy;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client, target, token } = useSession();
  const { toast } = useToast();
  const versions = useApiQuery(qk.policyVersions(orgId, policy.id), () =>
    wrap(async () => (await client.policies.listVersions(orgId, policy.id)).versions),
  );
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const draft = (versions.data ?? []).find((v) => !v.publishedAt) ?? null;

  const createDraft = async () => {
    setBusy(true);
    const r = await wrap(() => client.policies.createVersion(orgId, policy.id, {}));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not start a version", description: r.error.message });
      return;
    }
    versions.reload();
  };

  const upload = async (version: PublicPolicyVersion, file: File) => {
    setBusy(true);
    const bytes = await file.arrayBuffer();
    const r = await wrap(() =>
      client.policies.putDocument(
        orgId,
        policy.id,
        version.id,
        bytes,
        file.type || "application/pdf",
        file.name,
      ),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Upload failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Attached ${file.name}` });
    versions.reload();
  };

  const publish = async (version: PublicPolicyVersion) => {
    setBusy(true);
    const r = await wrap(() => client.policies.publishVersion(orgId, policy.id, version.id));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Publish failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Published version ${version.version}` });
    versions.reload();
    onChanged();
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{policy.title}</DialogTitle>
          <DialogDescription>
            Version history. A published version can never be edited — correct a policy by
            publishing a new one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {versions.loading ? (
            <Skeleton className="h-16 w-full" />
          ) : (versions.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No versions yet.</p>
          ) : (
            <ul className="space-y-2">
              {(versions.data ?? []).map((v) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Version {v.version}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {v.publishedAt
                        ? `Published ${new Date(v.publishedAt).toLocaleDateString()}`
                        : "Draft"}
                      {v.hasDocument ? ` · ${v.filename ?? "document"}` : " · no document"}
                    </div>
                  </div>
                  {v.publishedAt ? (
                    <Badge variant="success">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      sealed
                    </Badge>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        ref={fileRef}
                        type="file"
                        className="hidden"
                        accept="application/pdf,text/plain,text/markdown"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void upload(v, file);
                          e.target.value = "";
                        }}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => fileRef.current?.click()}
                      >
                        <Upload className="h-3.5 w-3.5 mr-1.5" />
                        Upload
                      </Button>
                      <Button size="sm" disabled={busy || !v.hasDocument} onClick={() => publish(v)}>
                        Publish
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2">
            {!draft && (
              <Button variant="secondary" disabled={busy} onClick={createDraft}>
                <Plus className="h-4 w-4 mr-1.5" />
                Start a new version
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={async () => {
                const ok = await downloadCsv(target, token, `/v1/organizations/${encodeURIComponent(orgId)}/policies/${encodeURIComponent(policy.id)}/export`);
                if (!ok) toast({ kind: "error", title: "Export failed" });
              }}
            >
              Export acknowledgments (CSV)
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
