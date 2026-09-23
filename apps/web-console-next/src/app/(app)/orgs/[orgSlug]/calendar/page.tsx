"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import type { PublicRecollectionRule } from "@saas/contracts/policies";
import { POLICY_CATEGORIES } from "@saas/contracts/policies";

const CATEGORY_LABELS: Record<string, string> = {
  "*": "Every category",
  handbook: "Handbook",
  harassment: "Anti-harassment",
  workplace_violence: "Workplace violence",
  safety: "Safety",
  other: "Other",
};

export default function CalendarPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const rules = useApiQuery(qk.rules(orgId), () =>
    wrap(async () => (await client.policies.listRules(orgId)).rules),
  );
  const [state, setState] = React.useState("");
  const [category, setCategory] = React.useState<string>("harassment");
  const [months, setMonths] = React.useState("12");

  const save = async (rule: { state: string; category: string; intervalMonths: number; enabled: boolean }) => {
    const r = await wrap(() =>
      client.policies.putRule(orgId, rule.state, rule.category, {
        intervalMonths: rule.intervalMonths,
        enabled: rule.enabled,
      }),
    );
    if (!r.ok) {
      toast({ kind: "error", title: "Could not save", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Saved ${rule.state} · ${CATEGORY_LABELS[rule.category] ?? rule.category}` });
    rules.reload();
  };

  const states = [...new Set((rules.data ?? []).map((r) => r.state))].sort((a, b) =>
    a === "*" ? 1 : b === "*" ? -1 : a.localeCompare(b),
  );
  const byKey = new Map((rules.data ?? []).map((r) => [`${r.state}/${r.category}`, r]));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Re-collection calendar</h1>
        <p className="text-sm text-muted-foreground">
          How long an acknowledgment stays current, by work state and policy category. Every night
          Ackstack asks again anyone whose last acknowledgment is older than this — no one has to
          remember. The most specific enabled rule wins.
        </p>
      </header>

      {rules.loading ? (
        <Skeleton className="h-40 w-full" />
      ) : rules.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{rules.error.code}</CardTitle>
            <CardDescription>{rules.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto pt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3">State</th>
                  {["*", ...POLICY_CATEGORIES].map((c) => (
                    <th key={c} className="py-1 pr-3">{CATEGORY_LABELS[c] ?? c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {states.map((s) => (
                  <tr key={s} className="border-t">
                    <td className="py-2 pr-3 font-medium">{s === "*" ? "Default" : s}</td>
                    {["*", ...POLICY_CATEGORIES].map((c) => {
                      const rule = byKey.get(`${s}/${c}`);
                      return (
                        <td key={c} className="py-2 pr-3">
                          {rule ? <RuleCell rule={rule} onSave={save} /> : <span className="text-muted-foreground">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a rule</CardTitle>
          <CardDescription>A two-letter state (or * for every state) and a category.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <Input className="w-20" placeholder="NY" value={state} onChange={(e) => setState(e.target.value)} />
          <select
            className="rounded-md border bg-background px-3 py-2 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {["*", ...POLICY_CATEGORIES].map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c] ?? c}
              </option>
            ))}
          </select>
          <Input className="w-24" type="number" min={1} max={120} value={months} onChange={(e) => setMonths(e.target.value)} />
          <span className="text-sm text-muted-foreground">months</span>
          <Button
            disabled={!state.trim()}
            onClick={() =>
              void save({
                state: state.trim().toUpperCase(),
                category,
                intervalMonths: Number(months) || 12,
                enabled: true,
              })
            }
          >
            <CalendarClock className="h-4 w-4 mr-1.5" />
            Save rule
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function RuleCell({
  rule,
  onSave,
}: {
  rule: PublicRecollectionRule;
  onSave: (rule: { state: string; category: string; intervalMonths: number; enabled: boolean }) => Promise<void>;
}) {
  const [months, setMonths] = React.useState(String(rule.intervalMonths));
  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-8 w-16"
        type="number"
        min={1}
        max={120}
        value={months}
        onChange={(e) => setMonths(e.target.value)}
        onBlur={() => {
          const n = Number(months);
          if (Number.isInteger(n) && n !== rule.intervalMonths) {
            void onSave({ state: rule.state, category: rule.category, intervalMonths: n, enabled: rule.enabled });
          }
        }}
      />
      <button
        type="button"
        className={`rounded px-1.5 py-0.5 text-xs ${rule.enabled ? "bg-green-600/15 text-green-700" : "bg-muted text-muted-foreground"}`}
        onClick={() => void onSave({ ...rule, enabled: !rule.enabled })}
      >
        {rule.enabled ? "on" : "off"}
      </button>
    </div>
  );
}
