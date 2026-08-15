"use client";

import { useState } from "react";
import useSWR from "swr";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ApiKeyRow = {
  id: number;
  label: string;
  revoked: boolean;
  created_at: string;
  last_used_at: string | null;
  created_by: string | null;
  access: string;
};

const fetcher = async (url: string): Promise<{ keys: ApiKeyRow[] }> => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`keys_fetch_failed_${response.status}`);
  return response.json();
};

function formatDate(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

export function ApiKeys({
  workspaceId,
  workspaceName,
}: {
  workspaceId: number;
  workspaceName: string;
}) {
  const key = `/api/v1/keys?workspace=${workspaceId}`;
  const { data, mutate } = useSWR(key, fetcher);

  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [readOnly, setReadOnly] = useState(false);

  const keys = data?.keys ?? [];

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          label: label.trim(),
          read_only: readOnly,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? `request_failed_${response.status}`);
        return;
      }
      setIssued(payload.plaintext);
      setCopied(false);
      setLabel("");
      setReadOnly(false);
      await mutate();
    } catch {
      setError("network_error");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/keys?id=${id}&workspace=${workspaceId}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        setError(`request_failed_${response.status}`);
        return;
      }
      setConfirming(null);
      await mutate();
    } catch {
      setError("network_error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-medium">API keys</h2>
        <p className="text-muted-foreground text-sm">
          Bearer tokens for the machine API, scoped to {workspaceName} alone. A
          key can read this workspace&apos;s board, and write to it unless it was
          minted read only. No key can create or revoke keys.
        </p>
      </div>

      {issued ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm font-medium">
            Copy this now — it is not stored and cannot be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="bg-background flex-1 overflow-x-auto rounded border px-2 py-1 font-mono text-xs">
              {issued}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(issued);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label htmlFor="key-label">New key label</Label>
          <Input
            id="key-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="n8n standup digest"
            className="w-64"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(event) => setReadOnly(event.target.checked)}
            className="size-4"
          />
          Read only
          <span className="text-muted-foreground text-xs">
            (can read the board, cannot change it)
          </span>
        </label>
        <Button
          size="sm"
          onClick={create}
          disabled={busy || label.trim().length === 0}
        >
          {busy ? "Working…" : "Create key"}
        </Button>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
            <tr>
              <th className="px-3 py-2 font-medium">Label</th>
              <th className="px-3 py-2 font-medium">Access</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Last used</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {keys.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="px-3 py-2 font-medium">{row.label}</td>
                <td className="text-muted-foreground px-3 py-2">{row.access}</td>
                <td className="text-muted-foreground px-3 py-2">
                  {formatDate(row.created_at)}
                </td>
                <td className="text-muted-foreground px-3 py-2">
                  {formatDate(row.last_used_at)}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={row.revoked ? "outline" : "secondary"}>
                    {row.revoked ? "revoked" : "active"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  {row.revoked ? null : confirming === row.id ? (
                    <span className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => revoke(row.id)}
                      >
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirming(row.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {keys.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="text-muted-foreground px-3 py-6 text-center text-xs"
                >
                  No keys yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
