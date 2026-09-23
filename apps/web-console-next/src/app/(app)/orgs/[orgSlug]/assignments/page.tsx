"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Send, BellRing } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import type {
  PublicAssignment,
  PublicPolicy,
} from "@saas/contracts/policies";

const REASON_LABELS: Record<string, string> = {
  initial: "Assigned",
  new_version: "New version",
  scheduled: "Re-collection",
};

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export default function AssignmentsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const assignments = useApiQuery(qk.assignments(orgId), () =>
    wrap(async () => (await client.policies.listAssignments(orgId)).assignments),
  );
  const policies = useApiQuery(qk.policies(orgId), () =>
    wrap(async () => (await client.policies.list(orgId)).policies),
  );
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<PublicAssignment | null>(null);

  const titles = new Map((policies.data ?? []).map((p) => [p.id, p.title]));
  const items = assignments.data ?? [];

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Assignments</h1>
          <p className="text-sm text-muted-foreground">
            A round sends one published version to everyone it matches, at that moment. Each member
            of staff gets a personal link — no login — and the acknowledgment records the version,
            the time and the IP.
          </p>
        </div>
        <Button onClick={() => setAssignOpen(true)}>
          <Send className="h-4 w-4 mr-1.5" />
          Assign a policy
        </Button>
      </header>

      {assignments.loading ? (
        <Skeleton className="h-24 w-full" />
      ) : assignments.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{assignments.error.code}</CardTitle>
            <CardDescription>{assignments.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Send}
          title="Nothing assigned yet"
          description="Publish a policy, add your staff, then assign it — by state, location or role."
          primaryAction={{ label: "Assign a policy", onClick: () => setAssignOpen(true) }}
        />
      ) : (
        <div className="space-y-2">
          {items.map((a) => (
            <Card
              key={a.id}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => setSelected(a)}
            >
              <CardContent className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {titles.get(a.policyId) ?? a.policyId}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(a.createdAt).toLocaleString()}
                    {a.dueAt ? ` · due ${new Date(a.dueAt).toLocaleDateString()}` : ""}
                    {a.audience.states.length ? ` · ${a.audience.states.join(", ")}` : ""}
                    {a.audience.locations.length ? ` · ${a.audience.locations.join(", ")}` : ""}
                    {a.audience.roles.length ? ` · ${a.audience.roles.join(", ")}` : ""}
                  </div>
                </div>
                <Badge variant="secondary">{REASON_LABELS[a.reason] ?? a.reason}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {assignOpen && (
        <AssignDialog
          orgId={orgId}
          policies={(policies.data ?? []).filter((p) => p.currentVersionId && p.status !== "retired")}
          onClose={() => setAssignOpen(false)}
          onDone={() => assignments.reload()}
        />
      )}
      {selected && (
        <AssignmentDialog
          orgId={orgId}
          assignment={selected}
          title={titles.get(selected.policyId) ?? selected.policyId}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function DebugLinks({ links }: { links: Array<{ staffId: string; link: string }> }) {
  if (links.length === 0) return null;
  return (
    <div className="rounded-md border border-dashed p-3 space-y-1">
      <div className="text-xs font-medium">Links (inline-delivery profile)</div>
      {links.map((l) => (
        <a key={l.staffId} href={l.link} className="block text-xs underline truncate" target="_blank" rel="noreferrer">
          {l.link}
        </a>
      ))}
    </div>
  );
}

function AssignDialog({
  orgId,
  policies,
  onClose,
  onDone,
}: {
  orgId: string;
  policies: PublicPolicy[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [policyId, setPolicyId] = React.useState(policies[0]?.id ?? "");
  const [states, setStates] = React.useState("");
  const [locations, setLocations] = React.useState("");
  const [roles, setRoles] = React.useState("");
  const [dueAt, setDueAt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [links, setLinks] = React.useState<Array<{ staffId: string; link: string }> | null>(null);

  const submit = async () => {
    setBusy(true);
    const r = await wrap(() =>
      client.policies.createAssignment(orgId, {
        policyId,
        audience: {
          states: splitList(states).map((s) => s.toUpperCase()),
          locations: splitList(locations),
          roles: splitList(roles),
        },
        ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
      }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not assign", description: r.error.message });
      return;
    }
    toast({
      kind: "success",
      title: `Sent to ${r.data.tally.pending} member(s) of staff`,
      description: r.data.sent < r.data.tally.pending ? "The rest go out within ten minutes." : undefined,
    });
    onDone();
    if (r.data.debugLinks && r.data.debugLinks.length > 0) setLinks(r.data.debugLinks);
    else onClose();
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign a policy</DialogTitle>
          <DialogDescription>
            Leave a filter empty to include everyone. Staff added later are picked up by the next
            round, not this one.
          </DialogDescription>
        </DialogHeader>
        {links ? (
          <DebugLinks links={links} />
        ) : policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">Publish a version of a policy first.</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="policy">Policy</Label>
              <select
                id="policy"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={policyId}
                onChange={(e) => setPolicyId(e.target.value)}
              >
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="states">States</Label>
              <Input id="states" placeholder="NY, IL" value={states} onChange={(e) => setStates(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="locations">Locations</Label>
              <Input id="locations" placeholder="Astoria store" value={locations} onChange={(e) => setLocations(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="roles">Roles</Label>
              <Input id="roles" placeholder="shift lead" value={roles} onChange={(e) => setRoles(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="due">Due</Label>
              <Input id="due" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
            <Button disabled={busy || !policyId} onClick={submit}>
              <Send className="h-4 w-4 mr-1.5" />
              Send
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AssignmentDialog({
  orgId,
  assignment,
  title,
  onClose,
}: {
  orgId: string;
  assignment: PublicAssignment;
  title: string;
  onClose: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const detail = useApiQuery(qk.assignment(orgId, assignment.id), () =>
    wrap(() => client.policies.getAssignment(orgId, assignment.id)),
  );
  const [busy, setBusy] = React.useState(false);
  const [links, setLinks] = React.useState<Array<{ staffId: string; link: string }>>([]);

  const remind = async () => {
    setBusy(true);
    const r = await wrap(() => client.policies.remindAssignment(orgId, assignment.id));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Reminder failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Reminded ${r.data.reminded} member(s) of staff` });
    setLinks(r.data.debugLinks ?? []);
    detail.reload();
  };

  const tally = detail.data?.tally;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {REASON_LABELS[assignment.reason] ?? assignment.reason} ·{" "}
            {new Date(assignment.createdAt).toLocaleString()}
          </DialogDescription>
        </DialogHeader>
        {detail.loading || !detail.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2 text-sm">
              <Badge variant="success">{tally?.acknowledged ?? 0} acknowledged</Badge>
              <Badge variant="secondary">{tally?.pending ?? 0} pending</Badge>
              {tally && tally.superseded > 0 && <Badge variant="secondary">{tally.superseded} superseded</Badge>}
            </div>
            <ul className="max-h-72 overflow-y-auto divide-y rounded-md border">
              {detail.data.acknowledgments.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate">{a.staffName}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {a.staffEmail}
                      {a.acknowledgedAt
                        ? ` · v${a.version} on ${new Date(a.acknowledgedAt).toLocaleString()}${a.ackIp ? ` from ${a.ackIp}` : ""}`
                        : a.sentAt
                          ? ` · sent ${new Date(a.sentAt).toLocaleDateString()}`
                          : " · queued"}
                    </div>
                  </div>
                  <Badge variant={a.status === "acknowledged" ? "success" : "secondary"}>{a.status}</Badge>
                </li>
              ))}
            </ul>
            {(tally?.pending ?? 0) > 0 && (
              <Button variant="secondary" disabled={busy} onClick={remind}>
                <BellRing className="h-4 w-4 mr-1.5" />
                Remind everyone pending
              </Button>
            )}
            <DebugLinks links={links} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
