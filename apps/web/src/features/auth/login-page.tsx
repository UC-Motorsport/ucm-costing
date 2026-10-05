import { useState, type FormEvent } from "react"
import { LoaderCircle, LockKeyhole } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ApiError, api, type AuthSession } from "@/lib/api"

const developmentAccount =
  import.meta.env.VITE_DEVELOPMENT_ACCOUNT === "true"

export function LoginPage({
  onAuthenticated,
}: {
  onAuthenticated: (session: AuthSession) => void
}) {
  const [email, setEmail] = useState("")
  const [key, setKey] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      onAuthenticated(await api.login(email, key))
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Sign in could not be completed. Try again.",
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted/25 px-4 py-10">
      <Card className="w-full max-w-[420px] shadow-sm">
        <CardHeader className="space-y-5">
          <p className="text-sm font-semibold tracking-tight">UCM Costing</p>
          <div>
            <CardTitle asChild>
              <h1>Sign in to UCM Costing</h1>
            </CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              {developmentAccount
                ? "Local administrator login: test@localhost.invalid / admin-test"
                : "Use your email address and the access key for your account role."}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            {error && (
              <Alert variant="destructive">
                <LockKeyhole />
                <AlertTitle>Sign in failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Email</span>
              <Input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={254}
                required
                autoFocus
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Key</span>
              <Input
                type="password"
                autoComplete="current-password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                required
              />
            </label>
            <Button
              className="w-full"
              type="submit"
              disabled={submitting || !email.trim() || !key}
            >
              {submitting && <LoaderCircle className="animate-spin" />}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
