import { DrizzleAdapter } from "@auth/drizzle-adapter";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

import { authConfig } from "@/auth.config";
import { db } from "@/db";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";
import { isAllowedEmail } from "@/lib/env";
import { ensureDefaultMembership } from "@/lib/workspace";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [GitHub],
  callbacks: {
    ...authConfig.callbacks,
    /**
     * The allowlist is the whole authorization model for humans: three known
     * addresses, no self-service signup. Anyone else is turned away before a
     * user row is created.
     */
    signIn({ user, profile }) {
      return isAllowedEmail(user.email ?? (profile?.email as string | undefined));
    },
  },
  events: {
    async signIn({ user }) {
      if (!user.id || !user.email) return;
      try {
        await ensureDefaultMembership(user.id, user.email);
      } catch (error) {
        // `events.signIn` is bare-awaited in @auth/core before the session
        // cookies are returned, so a throw here aborts the whole sign-in with
        // ?error=Configuration — including for users who are already members.
        // Membership is recoverable on the next sign-in; authentication is not
        // worth blocking on it.
        console.error("ensureDefaultMembership failed", error);
      }
    },
  },
});
