import { redirect } from "next/navigation";

import { auth, signIn } from "@/auth";
import { Button } from "@/components/ui/button";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");

  const { error } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Conduit</h1>
          <p className="text-muted-foreground text-sm">
            Sign in with GitHub. Access is limited to the allowlisted team.
          </p>
        </div>

        {error ? (
          <p className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
            {error === "AccessDenied"
              ? "That GitHub account is not on the allowlist."
              : "Sign-in failed. Try again."}
          </p>
        ) : null}

        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <Button type="submit" className="w-full">
            Continue with GitHub
          </Button>
        </form>
      </div>
    </main>
  );
}
