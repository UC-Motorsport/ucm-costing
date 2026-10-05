import { useState } from "react"
import { LogOut, LoaderCircle, Users } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAuth } from "@/features/auth/auth-context"

export function CurrentUserMenu({
  onManageUsers,
}: {
  onManageUsers: () => void
}) {
  const { session, logout } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)
  const { user, capabilities } = session

  const signOut = async () => {
    setLoggingOut(true)
    try {
      await logout()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Sign out failed",
      )
      setLoggingOut(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={`Account menu for ${user.displayName}`}
        >
          {loggingOut ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <span className="grid size-8 place-items-center rounded-full bg-slate-800 text-[11px] font-semibold text-white">
              {initials(user.displayName)}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-semibold text-foreground">
            {user.displayName}
          </span>
          <span className="mt-0.5 block truncate">{user.email}</span>
          <span className="mt-1 block capitalize">{user.role}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {capabilities.canManageUsers && (
          <DropdownMenuItem onSelect={onManageUsers}>
            <Users />
            Manage users
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          variant="destructive"
          disabled={loggingOut}
          onSelect={() => void signOut()}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function initials(displayName: string): string {
  const pieces = displayName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (pieces.length === 0) return "?"
  return pieces
    .slice(0, 2)
    .map((piece) => piece[0]?.toUpperCase() ?? "")
    .join("")
}
