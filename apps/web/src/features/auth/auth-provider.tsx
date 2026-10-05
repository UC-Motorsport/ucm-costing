import {
  useCallback,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react"
import { useQueryClient } from "@tanstack/react-query"
import { CircleAlert, LoaderCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { AuthContext } from "@/features/auth/auth-context"
import { LoginPage } from "@/features/auth/login-page"
import {
  ApiError,
  api,
  onAuthenticationRequired,
  type AuthSession,
} from "@/lib/api"

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; session: AuthSession }
  | { status: "error"; error: Error }

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<AuthState>({ status: "loading" })

  const clearAuthenticatedState = useCallback(() => {
    queryClient.clear()
    setState({ status: "anonymous" })
  }, [queryClient])

  const loadSession = useCallback(async () => {
    setState({ status: "loading" })
    try {
      setState({
        status: "authenticated",
        session: await api.currentSession(),
      })
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setState({ status: "anonymous" })
        return
      }
      setState({
        status: "error",
        error:
          caught instanceof Error
            ? caught
            : new Error("Authentication could not be checked."),
      })
    }
  }, [])

  useEffect(
    () => onAuthenticationRequired(clearAuthenticatedState),
    [clearAuthenticatedState],
  )

  useEffect(() => {
    void loadSession()
  }, [loadSession])

  const logout = useCallback(async () => {
    await api.logout()
    clearAuthenticatedState()
  }, [clearAuthenticatedState])

  if (state.status === "loading") {
    return (
      <main
        className="grid min-h-screen place-items-center bg-muted/20"
        aria-label="Loading account"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Checking your account…
        </div>
      </main>
    )
  }

  if (state.status === "error") {
    return (
      <main className="grid min-h-screen place-items-center bg-muted/20 p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CircleAlert className="size-6 text-destructive" />
            <CardTitle asChild>
              <h1>Could not check your account</h1>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {state.error.message}
            </p>
            <Button className="mt-4" onClick={() => void loadSession()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (state.status === "anonymous") {
    return (
      <LoginPage
        onAuthenticated={(session) =>
          setState({ status: "authenticated", session })
        }
      />
    )
  }

  return (
    <AuthContext.Provider value={{ session: state.session, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
