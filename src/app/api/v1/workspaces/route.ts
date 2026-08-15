import {
  listWorkspaces,
  requireScope,
  resolveActor,
} from "@/lib/api/guards";
import { SCOPES } from "@/lib/api/scopes";
import { ok, unauthorized } from "@/lib/api/response";

export async function GET(request: Request) {
  const actor = await resolveActor(request);
  if (!actor) return unauthorized();

  const denied = requireScope(actor, SCOPES.BOARD_READ);
  if (denied) return denied;

  const workspaces = await listWorkspaces(actor);
  return ok({ workspaces });
}
