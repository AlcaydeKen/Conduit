import { listWorkspaces, resolveActor } from "@/lib/api/guards";
import { ok, unauthorized } from "@/lib/api/response";

export async function GET() {
  const actor = await resolveActor();
  if (!actor) return unauthorized();

  const workspaces = await listWorkspaces(actor);
  return ok({ workspaces });
}
