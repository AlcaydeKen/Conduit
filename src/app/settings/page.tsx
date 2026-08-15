import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { ApiKeys } from "@/components/settings/api-keys";
import { Button } from "@/components/ui/button";
import { listWorkspaces, resolveSessionActor } from "@/lib/api/guards";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const actor = await resolveSessionActor();
  if (!actor) redirect("/signin");

  const { workspace: workspaceParam } = await searchParams;
  const workspaces = await listWorkspaces(actor);

  const hint = Number(workspaceParam);
  const selected =
    workspaces.find((workspace) => workspace.id === hint) ?? workspaces[0];

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-muted-foreground text-sm">
            {selected ? selected.name : "No workspace"}
          </p>
        </div>
        {/* Rendering as an anchor, so base-ui must stop assuming a native
            <button> — otherwise it keeps the button semantics on an element
            that no longer has them. */}
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link href="/" />}
        >
          Back to board
        </Button>
      </header>

      {selected ? (
        <ApiKeys workspaceId={selected.id} workspaceName={selected.name} />
      ) : (
        <p className="text-muted-foreground text-sm">
          You are not a member of any workspace yet.
        </p>
      )}
    </main>
  );
}
