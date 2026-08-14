import { Suspense } from "react";
import { redirect } from "next/navigation";

import { auth, signOut } from "@/auth";
import { Board } from "@/components/board/board";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listWorkspaces,
  resolveActor,
  resolveWorkspace,
} from "@/lib/api/guards";
import { defaultSprintFilter, getBoard } from "@/lib/board-queries";
import type { SprintFilter } from "@/types/board";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; sprint?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const actor = await resolveActor();
  if (!actor) redirect("/signin");

  const { workspace: workspaceParam, sprint: sprintParam } = await searchParams;

  const hint = Number(workspaceParam);
  const workspace = await resolveWorkspace(
    actor,
    Number.isInteger(hint) && hint > 0 ? hint : null,
  );

  const userName = session.user.name ?? session.user.email ?? "you";

  if (!workspace) {
    return (
      <Shell userName={userName}>
        <p className="text-muted-foreground text-sm">
          You are not a member of any workspace yet. Run{" "}
          <code className="font-mono">pnpm db:seed</code> and sign in again.
        </p>
      </Shell>
    );
  }

  let sprintFilter: SprintFilter;
  if (sprintParam === "backlog") {
    sprintFilter = "backlog";
  } else if (sprintParam && Number.isInteger(Number(sprintParam))) {
    sprintFilter = Number(sprintParam);
  } else {
    sprintFilter = await defaultSprintFilter(workspace.id);
  }

  // Rendered server-side so the first paint has real cards; SWR takes over and
  // polls from there.
  const [board, workspaces] = await Promise.all([
    getBoard(workspace, sprintFilter),
    listWorkspaces(actor),
  ]);

  return (
    <Shell userName={userName}>
      <Suspense fallback={<BoardSkeleton />}>
        <Board initialBoard={board} workspaces={workspaces} />
      </Suspense>
    </Shell>
  );
}

function BoardSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-64 w-full" />
      ))}
    </div>
  );
}

function Shell({
  userName,
  children,
}: {
  userName: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <header className="flex items-center justify-between gap-4 border-b pb-4">
        <h1 className="text-xl font-semibold tracking-tight">Koban</h1>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">{userName}</span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/signin" });
            }}
          >
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      {children}
    </main>
  );
}
