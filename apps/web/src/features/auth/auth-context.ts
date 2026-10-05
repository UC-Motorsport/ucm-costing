import { createContext, useContext } from "react"

import type { AuthSession } from "@/lib/api"

export interface AuthContextValue {
  session: AuthSession
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider")
  }
  return context
}
