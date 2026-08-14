import NextAuth from "next-auth";

import { authConfig } from "@/auth.config";

export default NextAuth(authConfig).auth;

export const config = {
  /**
   * Page routes only. `/api/*` is excluded on purpose: the machine API
   * authenticates with Bearer keys, not cookies, and does it per handler.
   */
  matcher: ["/((?!api|signin|_next/static|_next/image|favicon.ico).*)"],
};
