/* oxlint-disable react/only-export-components -- Provider and hooks form one context API. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

const DEFAULT_CONFIRM_MESSAGE =
  "You have unsaved changes. Leave this screen and discard them?"

interface DirtyRegistration {
  key: string
  label: string
}

interface UnsavedChangesContextValue {
  setRegistration: (
    instanceId: symbol,
    registration: DirtyRegistration | null,
  ) => void
  hasUnsavedChanges: boolean
  dirtyCount: number
  dirtyKeys: readonly string[]
  dirtyLabels: readonly string[]
  confirmDiscard: (message?: string) => boolean
}

const UnsavedChangesContext =
  createContext<UnsavedChangesContextValue | null>(null)

export interface UnsavedChangesProviderProps {
  children: ReactNode
  confirmMessage?: string
}

export function UnsavedChangesProvider({
  children,
  confirmMessage = DEFAULT_CONFIRM_MESSAGE,
}: UnsavedChangesProviderProps) {
  const [registrations, setRegistrations] = useState<
    ReadonlyMap<symbol, DirtyRegistration>
  >(() => new Map())

  const setRegistration = useCallback(
    (instanceId: symbol, registration: DirtyRegistration | null) => {
      setRegistrations((current) => {
        const existing = current.get(instanceId)

        if (
          registration &&
          existing?.key === registration.key &&
          existing.label === registration.label
        ) {
          return current
        }
        if (!registration && !existing) {
          return current
        }

        const next = new Map(current)
        if (registration) {
          next.set(instanceId, registration)
        } else {
          next.delete(instanceId)
        }
        return next
      })
    },
    [],
  )

  const hasUnsavedChanges = registrations.size > 0
  const dirtyKeys = useMemo(
    () =>
      Array.from(
        new Set(Array.from(registrations.values(), ({ key }) => key)),
      ),
    [registrations],
  )
  const dirtyLabels = useMemo(
    () =>
      Array.from(
        new Set(Array.from(registrations.values(), ({ label }) => label)),
      ),
    [registrations],
  )

  const confirmDiscard = useCallback(
    (message?: string) => {
      if (!hasUnsavedChanges) return true
      if (typeof window === "undefined") return false
      return window.confirm(message ?? confirmMessage)
    },
    [confirmMessage, hasUnsavedChanges],
  )

  useEffect(() => {
    if (!hasUnsavedChanges) return

    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }

    window.addEventListener("beforeunload", preventUnload)
    return () => window.removeEventListener("beforeunload", preventUnload)
  }, [hasUnsavedChanges])

  const value = useMemo<UnsavedChangesContextValue>(
    () => ({
      setRegistration,
      hasUnsavedChanges,
      dirtyCount: registrations.size,
      dirtyKeys,
      dirtyLabels,
      confirmDiscard,
    }),
    [
      confirmDiscard,
      dirtyKeys,
      dirtyLabels,
      hasUnsavedChanges,
      registrations.size,
      setRegistration,
    ],
  )

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
    </UnsavedChangesContext.Provider>
  )
}

export interface UnsavedChangesRegistrationOptions {
  label?: string
}

/**
 * Registers a dirty surface for the lifetime of this hook instance.
 *
 * Each instance owns a unique token, so two mounted forms may safely use the
 * same logical key without one form's cleanup removing the other form.
 */
export function useUnsavedChangesRegistration(
  key: string,
  isDirty: boolean,
  { label = key }: UnsavedChangesRegistrationOptions = {},
) {
  const { setRegistration } = useRequiredUnsavedChangesContext()
  const instanceId = useRef(Symbol(`unsaved-changes:${key}`))

  useEffect(() => {
    setRegistration(
      instanceId.current,
      isDirty ? { key, label } : null,
    )
  }, [isDirty, key, label, setRegistration])

  useEffect(
    () => () => setRegistration(instanceId.current, null),
    [setRegistration],
  )
}

export interface UnsavedChangesState {
  hasUnsavedChanges: boolean
  dirtyCount: number
  dirtyKeys: readonly string[]
  dirtyLabels: readonly string[]
  confirmDiscard: (message?: string) => boolean
}

export function useUnsavedChanges(): UnsavedChangesState {
  const {
    hasUnsavedChanges,
    dirtyCount,
    dirtyKeys,
    dirtyLabels,
    confirmDiscard,
  } = useRequiredUnsavedChangesContext()

  return {
    hasUnsavedChanges,
    dirtyCount,
    dirtyKeys,
    dirtyLabels,
    confirmDiscard,
  }
}

function useRequiredUnsavedChangesContext() {
  const context = useContext(UnsavedChangesContext)
  if (!context) {
    throw new Error(
      "useUnsavedChanges must be used within an UnsavedChangesProvider",
    )
  }
  return context
}
