import {
  listWorkspaces,
  resolveActor,
} from "@/lib/api/guards";
import { SCOPES } from "@/lib/api/scopes";
import { ok } from "@/lib/api/response";

export async function GET(request: Request) {
  const auth = await resolveActor(request, SCOPES.BOARD_READ);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const workspaces = await listWorkspaces(actor);
  return ok({ workspaces });
}
