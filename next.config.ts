import type { NextConfig } from "next";

/**
 * `pnpm build` writes to `.next-build` so it cannot overwrite the `.next` that a
 * running `pnpm dev` is serving from. Building while the dev server is up
 * otherwise leaves it serving half-replaced chunks, and every route starts
 * returning a 500 that reads like an application bug and is not one.
 *
 * The split is driven by the npm lifecycle event rather than an env var
 * prefix, because `FOO=bar next build` in a package script does not work under
 * cmd.exe, which is what pnpm uses on Windows.
 */
const BUILD_SCRIPTS = new Set(["build", "start"]);

const nextConfig: NextConfig = {
  distDir:
    process.env.NEXT_DIST_DIR ??
    (BUILD_SCRIPTS.has(process.env.npm_lifecycle_event ?? "")
      ? ".next-build"
      : ".next"),
};

export default nextConfig;
