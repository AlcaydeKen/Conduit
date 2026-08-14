import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe half of the Auth.js config. No database adapter and no Node APIs,
 * so `middleware.ts` can import it. The full config lives in `src/auth.ts`.
 */
export const authConfig = {
  providers: [],
  pages: {
    signIn: "/signin",
    error: "/signin",
  },
  session: { strategy: "jwt" },
  callbacks: {
    authorized({ auth }) {
      return Boolean(auth?.user);
    },
    jwt({ token, user }) {
      if (user) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
} satisfies NextAuthConfig;
