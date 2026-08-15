import {
  defaultSprintFilter,
  getBoard,
  type SprintFilter,
} from "@/lib/board-queries";
import {
  parseIntParam,
  resolveActor,
  resolveWorkspace,
} from "@/lib/api/guards";
import { notFound, ok, unauthorized } from "@/lib/api/response";

export async function GET(request: Request) {
  const actor = await resolveActor(request);
  if (!actor) return unauthorized();

  const url = new URL(request.url);

  // `?workspace=` is a hint. Membership is proven inside resolveWorkspace, and
  // a workspace the caller is not a member of is reported as simply absent.
  const workspace = await resolveWorkspace(
    actor,
    parseIntParam(url.searchParams.get("workspace")),
  );
  if (!workspace) return notFound();

  const sprintParam = url.searchParams.get("sprint");
  let sprintFilter: SprintFilter;
  if (sprintParam === "backlog") {
    sprintFilter = "backlog";
  } else if (sprintParam) {
    const parsed = parseIntParam(sprintParam);
    if (!parsed) return notFound();
    sprintFilter = parsed;
  } else {
    sprintFilter = await defaultSprintFilter(workspace.id);
  }

  return ok(await getBoard(workspace, sprintFilter));
}
