import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  KeyRound,
  LoaderCircle,
  Shield,
  UserPlus,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useAuth } from "@/features/auth/auth-context"
import {
  ApiError,
  api,
  type SystemRole,
  type UserRecord,
} from "@/lib/api"

export function UsersPage() {
  const { session } = useAuth()
  const queryClient = useQueryClient()
  const users = useQuery({
    queryKey: ["users"],
    queryFn: api.users,
  })
  const [addUserOpen, setAddUserOpen] = useState(false)
  const [pendingUserId, setPendingUserId] = useState<string | null>(null)

  const updateAccess = useMutation({
    mutationFn: ({
      user,
      changes,
    }: {
      user: UserRecord
      changes: { role?: SystemRole; status?: "active" | "disabled" }
    }) => api.updateUser(user.id, {
      expectedVersion: user.version,
      ...changes,
    }),
    onMutate: ({ user }) => setPendingUserId(user.id),
    onSuccess: async ({ user }) => {
      await queryClient.invalidateQueries({ queryKey: ["users"] })
      toast.success(`${user.displayName} updated`)
    },
    onError: showMutationError,
    onSettled: () => setPendingUserId(null),
  })

  const revokeSessions = useMutation({
    mutationFn: (user: UserRecord) => api.revokeUserSessions(user.id),
    onMutate: (user) => setPendingUserId(user.id),
    onSuccess: ({ revokedSessions }, user) => {
      toast.success(
        `${revokedSessions} session${
          revokedSessions === 1 ? "" : "s"
        } revoked for ${user.displayName}`,
      )
    },
    onError: showMutationError,
    onSettled: () => setPendingUserId(null),
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Team users</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Add accounts, change system access, disable users, and revoke
            active sessions. Access applies to this team workspace.
          </p>
        </div>
        <Button onClick={() => setAddUserOpen(true)}>
          <UserPlus />
          Add user
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {users.isLoading ? (
            <div
              className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
              role="status"
            >
              <LoaderCircle className="size-4 animate-spin" />
              Loading users…
            </div>
          ) : users.isError ? (
            <Alert variant="destructive">
              <Shield />
              <AlertTitle>Could not load users</AlertTitle>
              <AlertDescription>
                {users.error instanceof Error
                  ? users.error.message
                  : "Request failed"}
              </AlertDescription>
            </Alert>
          ) : (
            <Table
              className="min-w-[820px]"
              containerClassName="rounded-lg border"
              containerProps={{
                role: "region",
                "aria-label": "User accounts",
                tabIndex: 0,
              }}
            >
              <TableHeader>
                <TableRow className="bg-muted/35">
                  <TableHead>User</TableHead>
                  <TableHead className="w-36">Role</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-40">Updated</TableHead>
                  <TableHead className="w-72 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data?.users.map((user) => {
                  const pending = pendingUserId === user.id
                  return (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="font-medium">
                          {user.displayName}
                          {user.id === session.user.id && (
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              (you)
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {user.email}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={user.role}
                          onValueChange={(role) =>
                            updateAccess.mutate({
                              user,
                              changes: { role: role as SystemRole },
                            })
                          }
                          disabled={pending}
                        >
                          <SelectTrigger
                            className="h-8 w-full"
                            aria-label={`Role for ${user.displayName}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="editor">Editor</SelectItem>
                            <SelectItem value="viewer">Viewer</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            user.status === "active"
                              ? "outline"
                              : user.status === "disabled"
                                ? "destructive"
                                : "secondary"
                          }
                          className="capitalize"
                        >
                          {user.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(user.updatedAt).toLocaleString("en-NZ")}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() =>
                              updateAccess.mutate({
                                user,
                                changes: {
                                  status:
                                    user.status === "disabled"
                                      ? "active"
                                      : "disabled",
                                },
                              })
                            }
                          >
                            {pending ? (
                              <LoaderCircle className="animate-spin" />
                            ) : user.status === "disabled" ? (
                              <Check />
                            ) : (
                              <Shield />
                            )}
                            {user.status === "disabled" ? "Enable" : "Disable"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => revokeSessions.mutate(user)}
                          >
                            <KeyRound />
                            Revoke sessions
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AddUserDialog
        open={addUserOpen}
        onOpenChange={setAddUserOpen}
        onCreated={() => {
          setAddUserOpen(false)
          void queryClient.invalidateQueries({ queryKey: ["users"] })
        }}
      />
    </div>
  )
}

function AddUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [displayName, setDisplayName] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<SystemRole>("editor")
  const createUser = useMutation({
    mutationFn: () =>
      api.createUser({
        displayName: displayName.trim(),
        email: email.trim(),
        role,
      }),
    onSuccess: ({ user }) => {
      onCreated()
      setDisplayName("")
      setEmail("")
      setRole("editor")
      toast.success(`${user.displayName} added`)
    },
    onError: showMutationError,
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!createUser.isPending) onOpenChange(nextOpen)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            Create an active account. Editors, viewers, and administrators use
            separate role-specific access keys.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Display name</span>
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              minLength={2}
              maxLength={100}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Email</span>
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="off"
              maxLength={254}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">System role</span>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as SystemRole)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="editor">Editor</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createUser.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => createUser.mutate()}
            disabled={
              createUser.isPending ||
              displayName.trim().length < 2 ||
              !email.trim()
            }
          >
            {createUser.isPending && <LoaderCircle className="animate-spin" />}
            Create user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function showMutationError(error: unknown) {
  toast.error(
    error instanceof ApiError || error instanceof Error
      ? error.message
      : "Request failed",
  )
}
