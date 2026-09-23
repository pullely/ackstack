"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Users, Upload } from "lucide-react";
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
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { downloadCsv } from "@/lib/csv-download";
import type { StaffInput } from "@saas/contracts/policies";

export default function StaffPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

/**
 * The roster is pasted, not typed. Every business this is for already has the
 * list in a spreadsheet, and re-pasting it is an update — the identity of a
 * member of staff is their email, so a re-upload never duplicates anyone.
 */
function parseRoster(text: string): { rows: StaffInput[]; errors: string[] } {
  const rows: StaffInput[] = [];
  const errors: string[] = [];
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      const parts = line.split(/\s*[,\t]\s*/);
      const [fullName, email, workState, location, role] = parts;
      if (!fullName || !email) {
        errors.push(`Line ${index + 1}: needs at least a name and an email`);
        return;
      }
      rows.push({
        fullName,
        email,
        workState: workState || null,
        location: location || null,
        role: role || null,
      });
    });
  return { rows, errors };
}

function Inner({ orgId }: { orgId: string }) {
  const { client, target, token } = useSession();
  const { toast } = useToast();
  const [state, setState] = React.useState("");
  const staff = useApiQuery(qk.staff(orgId), () =>
    wrap(async () => (await client.policies.listStaff(orgId)).staff),
  );
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const items = (staff.data ?? []).filter((s) =>
    state ? (s.workState ?? "") === state.toUpperCase() : true,
  );
  const states = Array.from(
    new Set((staff.data ?? []).map((s) => s.workState).filter(Boolean) as string[]),
  ).sort();

  const submit = async () => {
    const { rows, errors } = parseRoster(text);
    if (errors.length > 0) {
      toast({ kind: "error", title: "Could not read the roster", description: errors[0]! });
      return;
    }
    if (rows.length === 0) {
      toast({ kind: "error", title: "Nothing to import" });
      return;
    }
    setBusy(true);
    const r = await wrap(() => client.policies.createStaff(orgId, { staff: rows }));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Import failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Saved ${rows.length} staff` });
    setOpen(false);
    setText("");
    staff.reload();
  };

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Staff</h1>
          <p className="text-sm text-muted-foreground">
            Who acknowledges. Tagged by work state, location and role — the state is what chooses
            the re-collection clock.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Upload className="h-4 w-4 mr-1.5" />
              Import roster
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Import roster</DialogTitle>
              <DialogDescription>
                One person per line:{" "}
                <code className="text-xs">name, email, state, location, role</code>. Re-importing
                the same list updates people rather than duplicating them.
              </DialogDescription>
            </DialogHeader>
            <textarea
              className="w-full h-48 rounded-md border bg-background p-2 text-sm font-mono"
              placeholder={"Ada Okafor, ada@example.com, NY, Astoria store, shift lead"}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={submit}>
                Import
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </header>

      {states.length > 0 && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={state === "" ? "default" : "secondary"}
            onClick={() => setState("")}
          >
            All
          </Button>
          {states.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={state === s ? "default" : "secondary"}
              onClick={() => setState(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      {staff.loading ? (
        <Skeleton className="h-32 w-full" />
      ) : staff.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{staff.error.code}</CardTitle>
            <CardDescription>{staff.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No staff yet"
          description="Paste your roster in and Ackstack will know who to send each policy to."
          primaryAction={{ label: "Import roster", onClick: () => setOpen(true) }}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">State</th>
                  <th className="px-4 py-2 font-medium">Location</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Trail</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="px-4 py-2">{s.fullName}</td>
                    <td className="px-4 py-2 text-muted-foreground">{s.email}</td>
                    <td className="px-4 py-2">{s.workState ?? "—"}</td>
                    <td className="px-4 py-2">{s.location ?? "—"}</td>
                    <td className="px-4 py-2">{s.role ?? "—"}</td>
                    <td className="px-4 py-2">
                      <Badge variant={s.status === "active" ? "success" : "secondary"}>
                        {s.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                          const ok = await downloadCsv(target, token, `/v1/organizations/${encodeURIComponent(orgId)}/staff/${encodeURIComponent(s.id)}/export`);
                          if (!ok) toast({ kind: "error", title: "Export failed" });
                        }}
                      >
                        CSV
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
