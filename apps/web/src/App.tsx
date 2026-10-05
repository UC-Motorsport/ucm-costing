import { PartFlag } from "@/features/bom/part-flag"
import { extendCostBreakdown } from "@ucm/domain"
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  AlertTriangle,
  BookOpen,
  Box,
  Calculator,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  FileCheck2,
  FileOutput,
  FileSpreadsheet,
  FileText,
  Folder,
  Hash,
  Info,
  ListFilter,
  LoaderCircle,
  Menu,
  PackageCheck,
  Search,
  ShieldAlert,
  ShieldCheck,
  Upload,
  UsersRound,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { QueryError } from "@/components/query-error"
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  resolveValidationIssueTarget,
  validationIssueTargetHref,
  type CriticalDatasheetTag,
  type NodeEditorSection,
  type ValidationIssueTarget,
} from "@/features/validation/issue-target"
import { EvidenceList } from "@/features/evidence/evidence-list"
import { FeatureTreeNavigator } from "@/features/bom/feature-tree-navigator"
import { RecordInspector } from "@/features/bom/record-inspector"
import { SelectedItemVisual } from "@/features/bom/selected-item-visual"
import { SystemManagementDialog } from "@/features/bom/system-management-dialog"
import { buildPropagatedIssueIndex } from "@/features/bom/validation-index"
import { useAuth } from "@/features/auth/auth-context"
import { AuthProvider } from "@/features/auth/auth-provider"
import { CurrentUserMenu } from "@/features/auth/current-user-menu"
import {
  UnsavedChangesProvider,
  useUnsavedChanges,
  useUnsavedChangesRegistration,
} from "@/hooks/use-unsaved-changes"
import {
  ApiError,
  api,
  universal,
  type CostNode,
  type ImportCommitResult,
  type ImportPreview,
  type Meta,
  type ProjectDetail,
  type ProjectSummary,
  type ValidationIssue,
  type ValidationResult,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const NodeEditorWorkspace = lazy(() =>
  import("@/features/bom/node-editor-workspace").then((module) => ({
    default: module.NodeEditorWorkspace,
  })),
)
const ReportSetupPage = lazy(() =>
  import("@/features/workspace/report-setup-page").then((module) => ({
    default: module.ReportSetupPage,
  })),
)
const UsersPage = lazy(() =>
  import("@/features/users/users-page").then((module) => ({
    default: module.UsersPage,
  })),
)
const WorkspaceActivityPage = lazy(() =>
  import("@/features/activity/workspace-activity-page").then((module) => ({
    default: module.WorkspaceActivityPage,
  })),
)
const ReportsPage = lazy(() =>
  import("@/features/reports/reports-page").then((module) => ({
    default: module.ReportsPage,
  })),
)
const WorkspacePortabilityControls = lazy(() =>
  import("@/features/workspace/workspace-portability-controls").then(
    (module) => ({ default: module.WorkspacePortabilityControls }),
  ),
)
const CataloguePage = lazy(() =>
  import("@/features/catalogue/catalogue-page").then((module) => ({
    default: module.default,
  })),
)

export type Page =
  | "bom"
  | "setup"
  | "import"
  | "validation"
  | "reports"
  | "catalogue"
  | "sources"
  | "activity"
  | "users"
type ValidationFilter = "all" | "blocker" | "warning" | "notice"

const navigation: Array<{
  page: Page
  label: string
  icon: typeof Calculator
}> = [
  { page: "bom", label: "Bill of materials", icon: Calculator },
  { page: "setup", label: "Report setup", icon: FileCheck2 },
  { page: "import", label: "Import", icon: Upload },
  { page: "validation", label: "Validation", icon: ShieldCheck },
  { page: "reports", label: "Reports", icon: FileOutput },
  { page: "catalogue", label: "Catalogue", icon: ListFilter },
  { page: "sources", label: "Rule pack", icon: BookOpen },
  { page: "activity", label: "Activity", icon: Clock3 },
  { page: "users", label: "Users", icon: UsersRound },
]

const pageTitles: Record<Page, string> = {
  bom: "Bill of materials",
  setup: "Report setup",
  import: "Import spreadsheet",
  validation: "Validation",
  reports: "Reports",
  catalogue: "Catalogue",
  sources: "Rule pack",
  activity: "Activity",
  users: "Users",
}

const pagePaths: Record<Page, string> = {
  bom: "/",
  setup: "/setup",
  import: "/import",
  validation: "/validation",
  reports: "/reports",
  catalogue: "/catalogue",
  sources: "/rule-pack",
  activity: "/activity",
  users: "/users",
}

const pageByPath = new Map(
  Object.entries(pagePaths).map(([page, path]) => [path, page as Page]),
)

const pinnedOfficialSourceUrls: Record<string, string> = {
  "392e6a0b4729df6fe43e57af9846859758195f5a80ba926c1a3756824892e070":
    "https://www.sme-a.org/client_images/5102753.xlsx",
  "4eee1b95f3c9b11d4a4b93bdcdedfd3273d9ae55278d1bd35afa238102c1b8d9":
    "https://www.sme-a.org/client_images/5276665.pdf",
  "1cfd33c17bcf8c7621283b3592633f816c29b0fa60bfc8eab9c1b5eaa9fc6688":
    "https://www.sme-a.org/client_images/5832409.pdf",
}

function pageFromPathname(pathname: string): Page | null {
  const normalised =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname
  return pageByPath.get(normalised) ?? null
}

function nodeIdFromLocation(): string | null {
  if (pageFromPathname(window.location.pathname) !== "bom") return null
  return new URLSearchParams(window.location.search).get("node")
}

function workspaceIdFromLocation(): string | null {
  return new URLSearchParams(window.location.search).get("workspace")
}

function pathForWorkspace(pathname: string, workspaceId: string): string {
  const url = new URL(pathname, window.location.origin)
  url.searchParams.set("workspace", workspaceId)
  return `${url.pathname}${url.search}${url.hash}`
}

type SelectedNodeSection = NodeEditorSection | "default"

function nodeSectionFromLocation(): SelectedNodeSection {
  const section = new URLSearchParams(window.location.search).get("section")
  return section === "record" ||
    section === "cost-lines" ||
    section === "evidence" ||
    section === "children"
    ? section
    : "default"
}

function validationFilterFromLocation(): ValidationFilter {
  const filter = new URLSearchParams(window.location.search).get("filter")
  return filter === "blocker" ||
    filter === "warning" ||
    filter === "notice"
    ? filter
    : "all"
}

function validationPageFromLocation(): number {
  const page = Number.parseInt(
    new URLSearchParams(window.location.search).get("page") ?? "1",
    10,
  )
  return Number.isFinite(page) && page > 0 ? page - 1 : 0
}

function validationContextPath(
  filter: ValidationFilter,
  page: number,
): string {
  const params = new URLSearchParams()
  if (filter !== "all") params.set("filter", filter)
  if (page > 0) params.set("page", String(page + 1))
  const query = params.toString()
  return `${pagePaths.validation}${query ? `?${query}` : ""}`
}

function currentLocationPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function focusAfterNavigation(id: string): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const target = document.getElementById(id)
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches
      target?.scrollIntoView({
        block: "center",
        behavior: reduceMotion ? "auto" : "smooth",
      })
      target?.focus({ preventScroll: true })
    })
  })
}

function trustedSourceUrl(
  source: Meta["sourceDocuments"][number],
): string | null {
  const candidate =
    source.originalUrl || pinnedOfficialSourceUrls[source.sha256]
  if (!candidate) return null

  try {
    const url = new URL(candidate)
    if (url.protocol !== "https:" || url.hostname !== "www.sme-a.org") {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

export default function App() {
  return (
    <AuthProvider>
      <UnsavedChangesProvider>
        <AppShell />
      </UnsavedChangesProvider>
    </AuthProvider>
  )
}

function AppShell() {
  const { session } = useAuth()
  const queryClient = useQueryClient()
  const { hasUnsavedChanges, dirtyKeys, dirtyLabels } =
    useUnsavedChanges()
  const [page, setPage] = useState<Page>(
    () => pageFromPathname(window.location.pathname) ?? "bom",
  )
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    nodeIdFromLocation,
  )
  const [selectedNodeSection, setSelectedNodeSection] =
    useState<SelectedNodeSection>(nodeSectionFromLocation)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    workspaceIdFromLocation,
  )
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false)
  const pendingNavigation = useRef<null | (() => void)>(null)
  const nodeReturnLocation = useRef<string | null>(null)
  const committedLocation = useRef(currentLocationPath())
  const allowNextPop = useRef(false)
  const pageHeading = useRef<HTMLHeadingElement>(null)
  const previousHeadingKey = useRef(`${page}:${selectedNodeId ?? ""}`)

  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta })
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects })
  const workspaceId = projects.data
    ? projects.data.projects.find(({ id }) => id === selectedProjectId)?.id ??
      projects.data.projects[0]?.id ??
      null
    : null
  const detail = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api.project(workspaceId!),
    enabled: Boolean(workspaceId),
  })
  const canUseImports =
    session.capabilities.canManageImports &&
    Boolean(meta.data?.features.legacyImports)
  const canUseImportsForWorkspace =
    canUseImports &&
    detail.data?.project.status !== "submitted" &&
    !detail.data?.project.is_historical

  const syncPageFromLocation = useCallback(() => {
    const next = pageFromPathname(window.location.pathname)
    if (!next) {
      const locationWorkspaceId = workspaceIdFromLocation()
      const fallbackPath = locationWorkspaceId
        ? pathForWorkspace(pagePaths.bom, locationWorkspaceId)
        : pagePaths.bom
      window.history.replaceState(null, "", fallbackPath)
      committedLocation.current = fallbackPath
      setPage("bom")
      setSelectedNodeId(null)
      setSelectedNodeSection("default")
      return
    }

    committedLocation.current = currentLocationPath()
    setSelectedProjectId(workspaceIdFromLocation())
    setPage(next)
    setSelectedNodeId(next === "bom" ? nodeIdFromLocation() : null)
    setSelectedNodeSection(
      next === "bom" ? nodeSectionFromLocation() : "default",
    )
  }, [])

  const requestNavigation = useCallback(
    (
      navigate: () => void,
      ignoredDirtyKeys: readonly string[] = [],
    ) => {
      const ignoredKeys = new Set(ignoredDirtyKeys)
      const hasBlockingUnsavedChanges = dirtyKeys.some(
        (key) => !ignoredKeys.has(key),
      )
      if (!hasBlockingUnsavedChanges) {
        navigate()
        return true
      }
      pendingNavigation.current = navigate
      setDiscardDialogOpen(true)
      return false
    },
    [dirtyKeys],
  )

  const commitLocation = useCallback(
    (
      path: string,
      options: {
        replace?: boolean
        state?: Record<string, unknown> | null
      } = {},
    ) => {
      const requestedUrl = new URL(path, window.location.origin)
      const nextPath =
        requestedUrl.searchParams.has("workspace") || !workspaceId
          ? path
          : pathForWorkspace(path, workspaceId)
      const current = currentLocationPath()
      if (current !== nextPath) {
        window.history[options.replace ? "replaceState" : "pushState"](
          options.state ?? null,
          "",
          nextPath,
        )
      } else if (options.replace) {
        window.history.replaceState(options.state ?? null, "", nextPath)
      }
      committedLocation.current = nextPath
      syncPageFromLocation()
      setMobileNavigationOpen(false)
    },
    [syncPageFromLocation, workspaceId],
  )

  useEffect(() => {
    if (!workspaceId || selectedProjectId === workspaceId) return
    setSelectedProjectId(workspaceId)
    commitLocation(pathForWorkspace(currentLocationPath(), workspaceId), {
      replace: true,
    })
  }, [commitLocation, selectedProjectId, workspaceId])

  useEffect(() => {
    const pageAllowed =
      (page !== "users" || session.capabilities.canManageUsers) &&
      (page !== "import" || !meta.isSuccess || canUseImportsForWorkspace)
    if (!pageAllowed) {
      commitLocation(pagePaths.bom, { replace: true })
    }
  }, [
    canUseImportsForWorkspace,
    commitLocation,
    meta.isSuccess,
    page,
    session.capabilities.canManageUsers,
  ])

  useEffect(() => {
    const handlePopState = () => {
      if (allowNextPop.current) {
        allowNextPop.current = false
        syncPageFromLocation()
        return
      }

      const targetLocation = currentLocationPath()
      if (!hasUnsavedChanges) {
        syncPageFromLocation()
        return
      }

      const restoreLocation = committedLocation.current
      window.history.pushState(
        { ucmRestoredAfterGuard: true },
        "",
        restoreLocation,
      )
      pendingNavigation.current = () => {
        allowNextPop.current = true
        window.history.back()
      }
      setDiscardDialogOpen(true)

      if (targetLocation === restoreLocation) {
        pendingNavigation.current = null
        setDiscardDialogOpen(false)
      }
    }

    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [hasUnsavedChanges, syncPageFromLocation])

  const validation = useQuery({
    queryKey: ["validation", workspaceId],
    queryFn: () => api.validation(workspaceId!),
    enabled: Boolean(workspaceId),
  })
  const selectedNode =
    detail.data?.flatNodes.find((node) => node.id === selectedNodeId) ?? null
  const canWriteWorkspace =
    detail.data?.project.status !== "submitted" &&
    !detail.data?.project.is_historical &&
    session.user.role !== "viewer"
  const reopenSubmission = useMutation({
    mutationFn: () => {
      const project = detail.data?.project
      if (!project || project.status !== "submitted") {
        throw new Error("workspace-not-submitted")
      }
      return api.updateWorkspace(project.id, {
        expectedVersion: project.version,
        status: "review",
      })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace"] }),
        queryClient.invalidateQueries({
          queryKey: ["validation", workspaceId],
        }),
      ])
      toast.success("Submission reopened for review")
    },
    onError: showMutationError,
  })

  useEffect(() => {
    document.title = `${selectedNode?.name ?? pageTitles[page]} · UCM Costing`
  }, [page, selectedNode?.name])

  useEffect(() => {
    const key = `${page}:${selectedNodeId ?? ""}`
    if (previousHeadingKey.current === key) return
    previousHeadingKey.current = key
    const frame = window.requestAnimationFrame(() => {
      pageHeading.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [page, selectedNodeId])

  useEffect(() => {
    if (
      page !== "bom" ||
      !selectedNodeId ||
      !detail.data ||
      selectedNode
    ) {
      return
    }

    const fallbackPath = workspaceId
      ? pathForWorkspace(pagePaths.bom, workspaceId)
      : pagePaths.bom
    window.history.replaceState(null, "", fallbackPath)
    committedLocation.current = fallbackPath
    setSelectedNodeId(null)
    setSelectedNodeSection("default")
    toast.error("That hierarchy item is not in this workspace.")
  }, [detail.data, page, selectedNode, selectedNodeId, workspaceId])

  const selectPage = (next: Page) => {
    const nextPath = pagePaths[next]
    if (currentLocationPath() === nextPath) {
      setMobileNavigationOpen(false)
      return
    }
    requestNavigation(() => commitLocation(nextPath))
  }

  const selectWorkspace = (nextProjectId: string) => {
    if (nextProjectId === workspaceId) return
    requestNavigation(() => {
      nodeReturnLocation.current = null
      setSelectedNodeId(null)
      setSelectedNodeSection("default")
      setSelectedProjectId(nextProjectId)
      commitLocation(pathForWorkspace(pagePaths[page], nextProjectId))
    })
  }

  const openWorkspace = (nextProjectId: string, nodeId?: string) => {
    nodeReturnLocation.current = null
    setSelectedProjectId(nextProjectId)
    setSelectedNodeId(nodeId ?? null)
    setSelectedNodeSection("default")
    const destination = nodeId
      ? `/?node=${encodeURIComponent(nodeId)}`
      : pagePaths.bom
    commitLocation(pathForWorkspace(destination, nextProjectId))
  }

  const openNode = (
    nodeId: string,
    replace = false,
    section: NodeEditorSection | "default" = "default",
    ignoredDirtyKeys: readonly string[] = [],
  ) => {
    if (!selectedNodeId) {
      nodeReturnLocation.current = null
    }
    const editorPath = `/?node=${encodeURIComponent(nodeId)}${
      section === "default" ? "" : `&section=${section}`
    }`
    if (currentLocationPath() === editorPath) return
    requestNavigation(
      () =>
        commitLocation(editorPath, {
          replace,
          state: { ucmNodeEditor: true },
        }),
      ignoredDirtyKeys,
    )
  }

  const closeNode = () => {
    requestNavigation(() => {
      const returnPath = nodeReturnLocation.current
      nodeReturnLocation.current = null
      commitLocation(returnPath ?? pagePaths.bom, { replace: true })
    })
  }

  const closeDeletedNode = () => {
    const returnPath = nodeReturnLocation.current
    nodeReturnLocation.current = null
    commitLocation(returnPath ?? pagePaths.bom, { replace: true })
  }

  const openValidationTarget = (target: ValidationIssueTarget) => {
    const href = validationIssueTargetHref(target)
    requestNavigation(() => {
      if (target.kind === "node") {
        nodeReturnLocation.current = currentLocationPath()
      }
      commitLocation(href)
      if (target.kind === "project") {
        focusAfterNavigation(target.field)
      } else if (target.kind === "page" && target.anchor) {
        focusAfterNavigation(target.anchor)
      }
    })
  }

  const confirmDiscard = () => {
    const navigate = pendingNavigation.current
    pendingNavigation.current = null
    setDiscardDialogOpen(false)
    navigate?.()
  }

  const keepEditing = () => {
    pendingNavigation.current = null
    setDiscardDialogOpen(false)
  }

  const primaryAction = (validation.data?.blockers ?? 0) > 0
    ? {
        page: "validation" as const,
        label: "Report blockers",
        shortLabel: "Blockers",
        icon: ShieldAlert,
      }
    : !detail.data?.project.report_setup_confirmed
      ? {
          page: "setup" as const,
          label: "Complete report setup",
          shortLabel: "Setup",
          icon: FileCheck2,
        }
      : {
          page: "reports" as const,
          label: "Generate report",
          shortLabel: "Report",
          icon: FileOutput,
        }
  const PrimaryActionIcon = primaryAction.icon

  if (detail.isError || meta.isError || projects.isError) {
    return (
      <FatalError
        error={detail.error ?? meta.error ?? projects.error}
        onRetry={() => {
          void detail.refetch()
          void meta.refetch()
          void projects.refetch()
        }}
      />
    )
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background lg:flex">
        <a
          href="#main-content"
          className="sr-only fixed top-3 left-3 z-50 rounded-md bg-background px-4 py-2 text-sm font-medium shadow-lg ring-2 ring-primary focus:not-sr-only"
        >
          Skip to main content
        </a>
        <aside className="hidden w-[238px] shrink-0 lg:fixed lg:inset-y-0 lg:flex">
          <Navigation
            page={page}
            meta={meta.data}
            tree={detail.data?.tree}
            selectedNodeId={selectedNodeId}
            onPageChange={selectPage}
            onOpenNode={(nodeId) => openNode(nodeId)}
            canManageUsers={session.capabilities.canManageUsers}
            canUseImports={canUseImportsForWorkspace}
          />
        </aside>

        <Sheet
          open={mobileNavigationOpen}
          onOpenChange={setMobileNavigationOpen}
        >
          <SheetContent side="left" className="w-[310px] border-0 p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
              <SheetDescription>UCM Costing sections</SheetDescription>
            </SheetHeader>
            <Navigation
              page={page}
              meta={meta.data}
              tree={detail.data?.tree}
              selectedNodeId={selectedNodeId}
              onPageChange={selectPage}
              onOpenNode={(nodeId) => openNode(nodeId)}
              canManageUsers={session.capabilities.canManageUsers}
              canUseImports={canUseImportsForWorkspace}
            />
          </SheetContent>
        </Sheet>

        <main
          id="main-content"
          tabIndex={-1}
          className="min-w-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 lg:ml-[238px]"
        >
          <header className="sticky top-0 z-30 flex h-[58px] items-center gap-3 border-b bg-background px-4 md:px-5">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setMobileNavigationOpen(true)}
              aria-label="Open navigation"
            >
              <Menu />
            </Button>
            <div className="min-w-0 flex-1">
              <h1
                ref={pageHeading}
                tabIndex={-1}
                className="truncate text-sm font-semibold tracking-tight outline-none focus-visible:underline focus-visible:decoration-2 focus-visible:decoration-slate-400 focus-visible:underline-offset-4"
              >
                {selectedNode?.name ?? pageTitles[page]}
              </h1>
            </div>
            {workspaceId && projects.data && (
              <Select value={workspaceId} onValueChange={selectWorkspace}>
                <SelectTrigger
                  className="w-[136px] sm:w-[220px]"
                  aria-label="Selected season workspace"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {projects.data.projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.season} · {project.name}
                      {project.is_historical ? " (historical)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {detail.data && projects.data && (
              <Suspense
                fallback={
                  <Button
                    variant="outline"
                    size="icon"
                    disabled
                    aria-label="Loading workspace tools"
                  >
                    <LoaderCircle className="animate-spin" />
                  </Button>
                }
              >
                <WorkspacePortabilityControls
                  detail={detail.data}
                  projects={projects.data.projects}
                  selectedNode={selectedNode}
                  role={session.user.role}
                  onOpenWorkspace={openWorkspace}
                />
              </Suspense>
            )}
            {page !== "users" &&
              page !== "reports" &&
              canUseImportsForWorkspace && (
              <Button
                variant="outline"
                className="hidden md:inline-flex"
                onClick={() => selectPage("import")}
              >
                <FileSpreadsheet />
                Import
              </Button>
            )}
            {page !== "users" && (
              <>
                {page !== "reports" && (
                  <Button
                    variant="outline"
                    className="hidden xl:inline-flex"
                    onClick={() => selectPage("reports")}
                  >
                    <Download />
                    Export
                  </Button>
                )}
                {page !== "reports" && (
                  <Button
                    variant="default"
                    className="hidden sm:inline-flex"
                    aria-label={
                      primaryAction.page === "validation"
                        ? `Review ${validation.data?.blockers ?? 0} blockers`
                        : undefined
                    }
                    onClick={() => selectPage(primaryAction.page)}
                    disabled={!detail.data || !validation.data}
                  >
                    {primaryAction.page !== "validation" && (
                      <PrimaryActionIcon />
                    )}
                    <span className="hidden sm:inline">
                      {primaryAction.label}
                    </span>
                    <span className="sm:hidden">
                      {primaryAction.shortLabel}
                    </span>
                    {primaryAction.page === "validation" && (
                      <span className="ml-1 rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-none text-primary">
                        {validation.data?.blockers ?? 0}
                      </span>
                    )}
                  </Button>
                )}
              </>
            )}
            <CurrentUserMenu onManageUsers={() => selectPage("users")} />
          </header>

          <div
            className={cn(
              page === "bom" && !selectedNode
                ? "p-0"
                : "mx-auto max-w-[1720px] p-4 md:p-6",
            )}
          >
            <Suspense
              fallback={
                <PageSkeleton label={`Loading ${pageTitles[page]}`} />
              }
            >
              {page === "users" && session.capabilities.canManageUsers ? (
                <UsersPage />
              ) : detail.isLoading || validation.isLoading ? (
                <PageSkeleton />
              ) : detail.isError || validation.isError ? (
                <FatalError
                  compact
                  error={detail.error ?? validation.error}
                  onRetry={() => {
                    void detail.refetch()
                    void validation.refetch()
                  }}
                />
              ) : detail.data && validation.data && meta.data ? (
                <>
                  {detail.data.project.is_historical && (
                    <Alert className="mb-5 border-blue-300 bg-blue-50 text-blue-950">
                      <Clock3 />
                      <AlertTitle>
                        Historical {detail.data.project.season} workspace · read-only
                      </AlertTitle>
                      <AlertDescription>
                        Browse and export this season here. Copy selected records
                        into the current workspace before revising them.
                      </AlertDescription>
                    </Alert>
                  )}
                  {detail.data.project.status === "submitted" && (
                    <Alert className="mb-5 border-slate-300 bg-slate-50 text-slate-950">
                      <ShieldCheck />
                      <AlertTitle>Submission locked · read-only</AlertTitle>
                      <AlertDescription>
                        The submitted ledger state is frozen. Reads and
                        downloads remain available. Reopen it as review before
                        changing costing data.
                      </AlertDescription>
                      {session.user.role !== "viewer" &&
                        !detail.data.project.is_historical && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="mt-3"
                            onClick={() => reopenSubmission.mutate()}
                            disabled={reopenSubmission.isPending}
                          >
                            {reopenSubmission.isPending && (
                              <LoaderCircle className="animate-spin" />
                            )}
                            Reopen for editing
                          </Button>
                        )}
                    </Alert>
                  )}
                  {page !== "validation" &&
                    page !== "bom" &&
                    page !== "reports" &&
                    !selectedNode &&
                    validation.data.blockers > 0 && (
                      <ValidationBanner
                        validation={validation.data}
                        onOpen={() => selectPage("validation")}
                      />
                    )}
                  {page === "bom" && (
                    <BomPage
                      detail={detail.data}
                      validation={validation.data}
                      systemDefinitions={meta.data.systems}
                      canWrite={canWriteWorkspace}
                      selectedNodeId={selectedNodeId}
                      selectedNodeSection={selectedNodeSection}
                      onOpenNode={openNode}
                      onCloseNode={closeNode}
                      onDeletedNode={closeDeletedNode}
                      nodeBackLabel={
                        nodeReturnLocation.current
                          ? "Back to validation"
                          : "Back to bill of materials"
                      }
                    />
                  )}
                  {page === "setup" && (
                    <ReportSetupPage
                      detail={detail.data}
                      canWrite={canWriteWorkspace}
                    />
                  )}
                  {page === "import" &&
                    canUseImportsForWorkspace && (
                    <ImportPage
                      project={detail.data.project}
                      onViewBom={() => selectPage("bom")}
                    />
                  )}
                  {page === "validation" && (
                    <ValidationPage
                      detail={detail.data}
                      validation={validation.data}
                      canWrite={canWriteWorkspace}
                      onOpenTarget={openValidationTarget}
                      onContextChange={(filter, nextPage) =>
                        commitLocation(
                          validationContextPath(filter, nextPage),
                          { replace: true },
                        )
                      }
                    />
                  )}
                  {page === "reports" && (
                    <ReportsPage
                      detail={detail.data}
                      canWrite={canWriteWorkspace}
                    />
                  )}
                  {page === "catalogue" && (
                    <CataloguePage
                      releaseId={detail.data.project.catalogue_release_id}
                      revisionLabel={detail.data.project.catalogue_revision}
                      canWrite={session.user.role !== "viewer"}
                    />
                  )}
                  {page === "sources" && (
                    <SourcesPage meta={meta.data} />
                  )}
                  {page === "activity" && (
                    <WorkspaceActivityPage projectId={detail.data.project.id} />
                  )}
                </>
              ) : (
                <PageSkeleton />
              )}
            </Suspense>
          </div>
        </main>
      </div>

      <Dialog
        open={discardDialogOpen}
        onOpenChange={(open) => {
          if (!open) keepEditing()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              {dirtyLabels.length === 1
                ? `${dirtyLabels[0]} has changes that have not been saved.`
                : `${dirtyLabels.length} areas have changes that have not been saved.`}{" "}
              Leaving now will discard them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={keepEditing}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={confirmDiscard}>
              Discard and continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

function Navigation({
  page,
  meta,
  tree,
  selectedNodeId,
  onPageChange,
  onOpenNode,
  canManageUsers,
  canUseImports,
}: {
  page: Page
  meta?: Meta
  tree?: CostNode
  selectedNodeId: string | null
  onPageChange: (page: Page) => void
  onOpenNode: (nodeId: string) => void
  canManageUsers: boolean
  canUseImports: boolean
}) {
  const toolsNavigationId = useId()
  const [toolsOpen, setToolsOpen] = useState(page !== "bom")
  const visibleNavigation = navigation.filter(
    ({ page: itemPage }) =>
      (itemPage !== "users" || canManageUsers) &&
      (itemPage !== "import" || canUseImports),
  )
  const bomNavigation = visibleNavigation.find((item) => item.page === "bom")!
  const toolNavigation = visibleNavigation.filter((item) => item.page !== "bom")

  useEffect(() => {
    if (page !== "bom") setToolsOpen(true)
  }, [page])

  return (
    <div className="flex h-full w-full flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-[58px] items-center border-b px-5">
        <span className="text-sm font-semibold tracking-tight">UCM Costing</span>
      </div>

      <nav
        className="flex min-h-0 flex-1 flex-col"
        aria-label="Primary navigation"
      >
        <div className="px-3 pt-3 pb-2">
          <NavigationItem
            item={bomNavigation}
            active={page === "bom" && !selectedNodeId}
            onSelect={() => onPageChange("bom")}
          />
        </div>

        {tree ? (
          <FeatureTreeNavigator
            tree={tree}
            selectedNodeId={selectedNodeId}
            onSelectNode={onOpenNode}
            className="min-h-0 flex-1"
          />
        ) : (
          <div className="flex-1 px-5 py-6 text-xs text-muted-foreground">
            Loading car structure…
          </div>
        )}

        <div className="border-t px-3 py-3">
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-[12px] font-semibold transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-expanded={toolsOpen}
            aria-controls={toolsNavigationId}
            onClick={() => setToolsOpen((current) => !current)}
          >
            {toolsOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            <span className="flex-1">Workspace tools</span>
            {!toolsOpen && page !== "bom" ? (
              <span className="size-1.5 rounded-full bg-primary" />
            ) : null}
          </button>

          {toolsOpen ? (
            <div id={toolsNavigationId} className="mt-1 space-y-0.5">
              {toolNavigation.map((item) => (
                <NavigationItem
                  key={item.page}
                  item={item}
                  active={item.page === page}
                  onSelect={() => onPageChange(item.page)}
                />
              ))}
              <div className="mt-3 space-y-2 border-t px-2 pt-3 text-[10px] text-muted-foreground">
                <div className="flex items-center justify-between gap-2">
                  <span>Rule pack</span>
                  <span
                    className="max-w-[112px] truncate font-mono text-foreground/75"
                    title={meta?.rulePack.version}
                  >
                    {meta?.rulePack.version ?? "…"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Cost catalogue</span>
                  <span className="font-mono text-foreground/75">
                    {meta?.catalogue.revision ?? "…"}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </nav>
    </div>
  )
}

function NavigationItem({
  item,
  active,
  onSelect,
}: {
  item: (typeof navigation)[number]
  active: boolean
  onSelect: () => void
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-8 w-full items-center gap-2 rounded px-2 text-left text-[13px] transition-colors",
        active
          ? "bg-primary/7 font-medium text-primary before:absolute before:-left-3 before:h-6 before:w-0.5 before:rounded-r before:bg-primary"
          : "text-foreground/82 hover:bg-muted",
      )}
    >
      <Icon className="size-[15px]" />
      {item.label}
    </button>
  )
}

function ValidationBanner({
  validation,
  onOpen,
}: {
  validation: ValidationResult
  onOpen: () => void
}) {
  return (
    <Alert className="mb-5 border-amber-300 bg-amber-50 text-amber-950">
      <AlertTriangle className="text-amber-600" />
      <AlertTitle>
        {validation.blockers} report blocker
        {validation.blockers === 1 ? "" : "s"} · {validation.warnings} warning
        {validation.warnings === 1 ? "" : "s"}
      </AlertTitle>
      <AlertDescription>
        Draft reports remain available. Competition-ready generation is locked
        until every blocker is resolved.
      </AlertDescription>
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-1/2 right-2 -translate-y-1/2 text-amber-900"
        onClick={onOpen}
      >
        Review
        <ChevronRight />
      </Button>
    </Alert>
  )
}

function BomPage({
  detail,
  validation,
  systemDefinitions,
  canWrite,
  selectedNodeId,
  selectedNodeSection,
  onOpenNode,
  onCloseNode,
  onDeletedNode,
  nodeBackLabel,
}: {
  detail: ProjectDetail
  validation: ValidationResult
  systemDefinitions: Meta["systems"]
  canWrite: boolean
  selectedNodeId: string | null
  selectedNodeSection: SelectedNodeSection
  onOpenNode: (
    nodeId: string,
    replace?: boolean,
    section?: NodeEditorSection,
    ignoredDirtyKeys?: readonly string[],
  ) => void
  onCloseNode: () => void
  onDeletedNode: () => void
  nodeBackLabel: string
}) {
  const evidence = useQuery({
    queryKey: ["evidence", detail.project.id],
    queryFn: () => api.evidence(detail.project.id),
  })
  const [search, setSearch] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [expandedMobileCosts, setExpandedMobileCosts] = useState<Set<string>>(
    new Set(),
  )
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(null)
  const [blockersOnly, setBlockersOnly] = useState(false)
  const lastSelectedNodeId = useRef<string | null>(selectedNodeId)
  const bomScrollY = useRef(0)
  const wasEditorOpen = useRef(Boolean(selectedNodeId))

  const defaultExpansionKey = useMemo(() => {
    const firstAssembly = detail.flatNodes.find(
      (node) => node.kind === "assembly",
    )
    return [
      detail.tree.id,
      ...detail.flatNodes
        .filter((node) => node.kind === "system")
        .map((node) => node.id),
      ...(firstAssembly ? [firstAssembly.id] : []),
    ].join(",")
  }, [detail.flatNodes, detail.tree.id])

  useEffect(() => {
    setExpanded(new Set(defaultExpansionKey.split(",").filter(Boolean)))
  }, [defaultExpansionKey, detail.project.id])

  useEffect(() => {
    const firstAssembly = detail.flatNodes.find(
      (node) => node.kind === "assembly",
    )
    const firstRecord = detail.flatNodes.find(
      (node) => node.kind !== "vehicle",
    )
    setInspectedNodeId(firstAssembly?.id ?? firstRecord?.id ?? null)
  }, [detail.project.id, detail.flatNodes])

  useEffect(() => {
    if (selectedNodeId) {
      if (!wasEditorOpen.current) {
        bomScrollY.current = window.scrollY
      }
      wasEditorOpen.current = true
      lastSelectedNodeId.current = selectedNodeId
      window.scrollTo({ top: 0 })
      return
    }

    const shouldRestoreBomPosition = wasEditorOpen.current
    wasEditorOpen.current = false
    if (!shouldRestoreBomPosition) return

    const lastId = lastSelectedNodeId.current
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: bomScrollY.current })
      if (lastId) {
        const triggerId = window.matchMedia("(min-width: 768px)").matches
          ? `node-editor-trigger-${lastId}`
          : `node-editor-trigger-mobile-${lastId}`
        document.getElementById(triggerId)?.focus()
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selectedNodeId])

  const issuesByNode = useMemo(
    () => buildPropagatedIssueIndex(detail.flatNodes, validation.issues),
    [detail.flatNodes, validation.issues],
  )
  const blockersByNode = useMemo(
    () =>
      buildPropagatedIssueIndex(
        detail.flatNodes,
        validation.issues,
        "blocker",
      ),
    [detail.flatNodes, validation.issues],
  )
  const nodeBlockerCount = useMemo(
    () =>
      validation.issues.filter(
        (issue) =>
          issue.severity === "blocker" &&
          issue.nodeId &&
          blockersByNode.has(issue.nodeId),
      ).length,
    [blockersByNode, validation.issues],
  )
  const expandableNodeIds = useMemo(
    () =>
      detail.flatNodes
        .filter((node) => node.children.length > 0)
        .map((node) => node.id),
    [detail.flatNodes],
  )
  const allHierarchyExpanded =
    expandableNodeIds.length > 0 &&
    expandableNodeIds.every((nodeId) => expanded.has(nodeId))

  const visibleNodes = useMemo(() => {
    let nodes: Array<{ node: CostNode; depth: number }>
    if (search.trim()) {
      const query = search.trim().toLowerCase()
      nodes = detail.flatNodes
        .filter(
          (node) =>
            node.kind !== "vehicle" &&
            `${node.full_number ?? ""} ${node.reference_id ?? ""} ${node.system_code ?? ""} ${node.name}`
              .toLowerCase()
              .includes(query),
        )
        .map((node) => ({ node, depth: node.kind === "part" ? 2 : 0 }))
    } else {
      nodes = flattenTree(detail.tree, expanded).filter(
        ({ node }) => node.kind !== "vehicle",
      )
    }
    return blockersOnly
      ? nodes.filter(
          ({ node }) => (blockersByNode.get(node.id)?.length ?? 0) > 0,
        )
      : nodes
  }, [blockersByNode, blockersOnly, detail, expanded, search])

  const selectedNode =
    detail.flatNodes.find((node) => node.id === selectedNodeId) ?? null
  const selectedNodeIssues = selectedNode
    ? validation.issues.filter((issue) => issue.nodeId === selectedNode.id)
    : []
  const selectedNodeEvidence = selectedNode
    ? evidence.data?.evidence.filter(
        (item) => item.node_id === selectedNode.id,
      ) ?? []
    : []
  const editableNodes = detail.flatNodes.filter(
    (node) => node.kind !== "vehicle",
  )
  const selectedNodeIndex = selectedNode
    ? editableNodes.findIndex((node) => node.id === selectedNode.id)
    : -1
  const previousNode =
    selectedNodeIndex > 0 ? editableNodes[selectedNodeIndex - 1] : null
  const nextNode =
    selectedNodeIndex >= 0 && selectedNodeIndex < editableNodes.length - 1
      ? editableNodes[selectedNodeIndex + 1]
      : null

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const inspectedNode =
    detail.flatNodes.find((node) => node.id === inspectedNodeId) ??
    visibleNodes[0]?.node ??
    null
  const inspectedIssues = inspectedNode
    ? issuesByNode.get(inspectedNode.id) ?? []
    : []
  const inspectedBlockers = inspectedNode
    ? blockersByNode.get(inspectedNode.id)?.length ?? 0
    : 0
  const inspectedDirectBlockers = inspectedNode
    ? validation.issues.filter(
        (issue) =>
          issue.severity === "blocker" &&
          issue.nodeId === inspectedNode.id,
      ).length
    : 0
  const inspectedEvidence = inspectedNode
    ? evidence.data?.evidence.filter(
        (item) => item.node_id === inspectedNode.id,
      ) ?? []
    : []
  const inspectedParts = inspectedNode
    ? collectNodeParts(inspectedNode)
    : []
  const inspectedCostedParts = inspectedParts.filter(
    (part) => part.costLines.length > 0,
  ).length
  const inspectedMissingVisuals = inspectedIssues.filter(
    (issue) => issue.code === "part-visual-missing",
  ).length

  if (selectedNode) {
    return (
      <div className="mx-auto w-full max-w-6xl">
        <div className="min-w-0">
          <Suspense fallback={<NodeEditorSkeleton />}>
            <NodeEditorWorkspace
              key={selectedNode.id}
              node={selectedNode}
              nodes={detail.flatNodes}
              project={detail.project}
              readOnly={!canWrite}
              validationIssues={selectedNodeIssues}
              initialSection={selectedNodeSection}
              onClose={onCloseNode}
              backLabel={nodeBackLabel}
              previousNode={previousNode}
              nextNode={nextNode}
              onNavigate={(nodeId) => onOpenNode(nodeId, true)}
              visual={({ chooseEvidenceFile, canUploadEvidence }) =>
                <SelectedItemVisual
                  node={selectedNode}
                  evidence={selectedNodeEvidence}
                  loading={evidence.isLoading}
                  onChooseFile={
                    canUploadEvidence ? chooseEvidenceFile : undefined
                  }
                />
              }
              onCreated={(nodeId, parentId, savedDraftKey) => {
                setExpanded((current) => {
                  const next = new Set(current)
                  next.add(parentId)
                  return next
                })
                onOpenNode(
                  nodeId,
                  true,
                  "record",
                  savedDraftKey ? [savedDraftKey] : [],
                )
              }}
              onDeleted={onDeletedNode}
            />
          </Suspense>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-58px)] min-[1180px]:grid min-[1180px]:grid-cols-[minmax(0,1fr)_278px]">
      <div className="min-w-0 border-r">
        <div className="flex min-h-[72px] flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="relative min-w-[220px] flex-1 md:max-w-[320px]">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search number or name"
              className="pl-9"
              aria-label="Search bill of materials"
            />
          </div>
          <SystemManagementDialog
            canWrite={canWrite}
            projectId={detail.project.id}
            vehicle={detail.tree}
            definitions={systemDefinitions}
          />
          {expandableNodeIds.length > 0 ? (
            <Button
              variant="outline"
              aria-label={
                allHierarchyExpanded
                  ? "Collapse all hierarchy"
                  : "Expand all hierarchy"
              }
              onClick={() =>
                setExpanded(
                  new Set(
                    allHierarchyExpanded
                      ? [detail.tree.id]
                      : expandableNodeIds,
                  ),
                )
              }
            >
              {allHierarchyExpanded ? (
                <ChevronDown />
              ) : (
                <ChevronRight />
              )}
              {allHierarchyExpanded ? "Collapse all" : "Expand all"}
            </Button>
          ) : null}
          <Button
            variant={blockersOnly ? "secondary" : "outline"}
            aria-pressed={blockersOnly}
            onClick={() => setBlockersOnly((current) => !current)}
          >
            <ListFilter />
            Blockers only
            <Badge variant="outline" className="ml-1 h-5 rounded px-1.5">
              {nodeBlockerCount}
            </Badge>
          </Button>
          <Button
            variant="link"
            className="px-1 text-muted-foreground"
            onClick={() => {
              setSearch("")
              setBlockersOnly(false)
            }}
          >
            Clear
          </Button>
        </div>
        <Table
          className="min-w-[980px] table-fixed border-separate border-spacing-0 text-[12px] [&_th]:h-12 [&_th]:border-b [&_th]:bg-background"
          containerClassName="hidden overscroll-x-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary md:block"
          containerProps={{
            role: "region",
            "aria-label":
              "Bill of materials cost table. Scroll horizontally to reach all cost and status columns.",
            tabIndex: 0,
            style: { scrollbarGutter: "stable" },
          }}
        >
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="sticky left-0 z-10 bg-background">
                Reference / item
              </TableHead>
              <TableHead className="w-[80px] text-center">Type</TableHead>
              <TableHead className="w-[48px] text-center">Qty</TableHead>
              <CostTableHead label="Material" className="w-[76px]" />
              <CostTableHead label="Process" className="w-[76px]" />
              <CostTableHead label="Fastener" className="w-[76px]" />
              <CostTableHead label="Tooling" className="w-[76px]" />
              <CostTableHead label="Total" className="w-[88px]" />
              <TableHead className="sticky right-0 z-10 w-[64px] border-l bg-background px-2 text-center">
                Blockers
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
              {visibleNodes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="h-40 text-center">
                    <Search className="mx-auto size-7 text-muted-foreground" />
                    <p className="mt-3 font-medium">
                      {blockersOnly
                        ? "No BOM items match the blockers-only filter"
                        : "No matching BOM items"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {blockersOnly
                        ? "Workspace-wide findings remain available in Validation."
                        : "Try a different part name, number, or reference."}
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                visibleNodes.map(({ node, depth }) => {
                  const rowBreakdown = extendCostBreakdown(
                    node.breakdown,
                    node.quantity,
                  )
                  const canExpand = node.children.length > 0
                  const blockers = blockersByNode.get(node.id) ?? []
                  const nodeNumber =
                    node.full_number ??
                    node.reference_id ??
                    node.system_code ??
                    "Unnumbered"
                  const itemContent = (
                    <>
                      {node.kind === "system" ? (
                        <Folder className="size-4 shrink-0" />
                      ) : node.kind === "part" ? (
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <Box className="size-4 shrink-0" />
                      )}
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {nodeNumber}
                      </span>
                      <span className="truncate">{node.name}</span>
                    </>
                  )

                  return (
                    <TableRow
                      key={node.id}
                      data-state={inspectedNode?.id === node.id ? "selected" : undefined}
                      className={cn(
                        "h-[50px]",
                        node.kind === "system" && "font-medium",
                      )}
                      onDoubleClick={() => onOpenNode(node.id)}
                    >
                      <TableCell
                        className={cn(
                          "sticky left-0 z-[1] p-0",
                          inspectedNode?.id === node.id
                            ? "bg-[#eef5f8]"
                            : "bg-background",
                        )}
                      >
                        <div
                          className="flex min-h-11 min-w-0 items-center"
                          style={{ paddingLeft: `${8 + depth * 18}px` }}
                        >
                          {canExpand ? (
                            <button
                              type="button"
                              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                              aria-label={`${expanded.has(node.id) ? "Collapse" : "Expand"} ${nodeNumber} ${node.name}`}
                              aria-expanded={expanded.has(node.id)}
                              onClick={() => toggleExpanded(node.id)}
                            >
                              {expanded.has(node.id) ? (
                                <ChevronDown className="size-4" />
                              ) : (
                                <ChevronRight className="size-4" />
                              )}
                            </button>
                          ) : (
                            <span className="size-8 shrink-0" />
                          )}
                          <button
                            type="button"
                            id={`node-editor-trigger-${node.id}`}
                            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                            aria-label={
                              node.kind === "system"
                                ? `Open system assembly tree ${nodeNumber} ${node.name}`
                                : `Inspect ${node.kind} ${nodeNumber} ${node.name}`
                            }
                            title={`${nodeNumber} — ${node.name}`}
                            onClick={() => {
                              if (node.kind === "system") {
                                onOpenNode(node.id, false, "children")
                                return
                              }
                              setInspectedNodeId(node.id)
                            }}
                          >
                            {itemContent}
                          </button>
                          <PartFlag node={node} canWrite={canWrite} />
                        </div>
                      </TableCell>
                      <TableCell className="text-center capitalize text-muted-foreground">
                        {node.kind}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {node.quantity}
                      </TableCell>
                      <MoneyCell value={rowBreakdown.material} />
                      <MoneyCell value={rowBreakdown.process} />
                      <MoneyCell value={rowBreakdown.fastener} />
                      <MoneyCell value={rowBreakdown.tooling} />
                      <MoneyCell value={rowBreakdown.total} emphasized />
                      <TableCell
                        className={cn(
                          "sticky right-0 z-[1] border-l px-2 text-center",
                          inspectedNode?.id === node.id
                            ? "bg-[#eef5f8]"
                            : "bg-background",
                        )}
                      >
                        <button
                          type="button"
                          className={cn(
                            "font-mono text-xs tabular-nums underline-offset-2",
                            blockers.length > 0
                              ? "font-semibold text-destructive underline"
                              : "text-muted-foreground",
                          )}
                          onClick={() => setInspectedNodeId(node.id)}
                          aria-label={`${blockers.length} blocker${blockers.length === 1 ? "" : "s"} for ${node.name}`}
                        >
                          {blockers.length}
                        </button>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
          </TableBody>
        </Table>

        <div
          className="divide-y md:hidden"
          role="list"
          aria-label="Bill of materials items"
        >
          {visibleNodes.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <Search className="mx-auto size-7 text-muted-foreground" />
              <p className="mt-3 font-medium">
                {blockersOnly
                  ? "No BOM items match the blockers-only filter"
                  : "No matching BOM items"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {blockersOnly
                  ? "Workspace-wide findings remain available in Validation."
                  : "Try a different part name, number, or reference."}
              </p>
            </div>
          ) : (
            visibleNodes.map(({ node, depth }) => {
              const rowBreakdown = extendCostBreakdown(
                node.breakdown,
                node.quantity,
              )
              const canExpand = node.children.length > 0
              const issues = issuesByNode.get(node.id) ?? []
              const nodeNumber =
                node.full_number ??
                node.reference_id ??
                node.system_code ??
                "Unnumbered"

              return (
                <article
                  key={node.id}
                  role="listitem"
                  className={cn(
                    "px-4 py-4",
                    node.kind === "system" && "bg-muted/20",
                  )}
                >
                  <div
                    className="flex min-w-0 items-start gap-1"
                    style={{ paddingLeft: `${Math.min(depth * 10, 30)}px` }}
                  >
                    {canExpand ? (
                      <button
                        type="button"
                        className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        aria-label={`${expanded.has(node.id) ? "Collapse" : "Expand"} ${nodeNumber} ${node.name}`}
                        aria-expanded={expanded.has(node.id)}
                        onClick={() => toggleExpanded(node.id)}
                      >
                        {expanded.has(node.id) ? (
                          <ChevronDown className="size-4" />
                        ) : (
                          <ChevronRight className="size-4" />
                        )}
                      </button>
                    ) : (
                      <span className="size-11 shrink-0" />
                    )}
                    <button
                      type="button"
                      id={`node-editor-trigger-mobile-${node.id}`}
                      className="min-w-0 flex-1 rounded-md px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label={
                        node.kind === "system"
                          ? `Open system assembly tree ${nodeNumber} ${node.name}`
                          : `Edit ${node.kind} ${nodeNumber} ${node.name}`
                      }
                      title={`${nodeNumber} — ${node.name}`}
                      onClick={() =>
                        onOpenNode(
                          node.id,
                          false,
                          node.kind === "system" ? "children" : undefined,
                        )
                      }
                    >
                      <span className="sr-only">
                        Hierarchy level {depth + 1}.{" "}
                      </span>
                      <span className="flex items-center gap-2">
                        {node.kind === "system" ? (
                          <Folder className="size-4 shrink-0" />
                        ) : node.kind === "part" ? (
                          <FileText className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <Box className="size-4 shrink-0" />
                        )}
                        <span className="truncate font-medium">
                          {node.name}
                        </span>
                      </span>
                      <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                        {nodeNumber}
                      </span>
                    </button>
                    <PartFlag node={node} canWrite={canWrite} />
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm font-semibold tabular-nums">
                        U$ {universal(rowBreakdown.total)}
                      </div>
                      <div className="mt-1">
                        <NodeStatus node={node} issues={issues} />
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                    <button
                      type="button"
                      className="flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label={`${node.name} ${node.kind} cost breakdown`}
                      aria-expanded={expandedMobileCosts.has(node.id)}
                      onClick={() =>
                        setExpandedMobileCosts((current) => {
                          const next = new Set(current)
                          if (next.has(node.id)) next.delete(node.id)
                          else next.add(node.id)
                          return next
                        })
                      }
                    >
                      <span className="capitalize text-muted-foreground">
                        {node.kind}
                      </span>
                      <span aria-hidden="true">·</span>
                      Cost breakdown
                      <ChevronDown
                        className={cn(
                          "size-3.5 transition-transform",
                          expandedMobileCosts.has(node.id) && "rotate-180",
                        )}
                      />
                    </button>
                    <span>Qty {node.quantity}</span>
                  </div>
                  {expandedMobileCosts.has(node.id) && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-muted/35 px-3 py-2 text-xs">
                      <MobileCost
                        label="Material"
                        value={rowBreakdown.material}
                      />
                      <MobileCost
                        label="Process"
                        value={rowBreakdown.process}
                      />
                      <MobileCost
                        label="Fastener"
                        value={rowBreakdown.fastener}
                      />
                      <MobileCost
                        label="Tooling"
                        value={rowBreakdown.tooling}
                      />
                    </div>
                  )}
                </article>
              )
            })
          )}
        </div>
        <div className="hidden min-h-[82px] grid-cols-[340px_minmax(0,1fr)_120px] items-center border-t text-xs md:grid">
          <div className="px-4 font-medium">Competition total</div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 text-muted-foreground">
            {(
              [
                ["material", "bg-[#c40d2f]"],
                ["process", "bg-[#2675bf]"],
                ["fastener", "bg-[#dfa20b]"],
                ["tooling", "bg-[#34a36f]"],
              ] as const
            ).map(([kind, colour]) => (
              <span key={kind} className="flex items-center gap-2">
                <span className={cn("size-2 rounded-full", colour)} />
                <span className="font-mono tabular-nums text-foreground">
                  U$ {universal(detail.breakdown[kind])}
                </span>
              </span>
            ))}
          </div>
          <div className="px-4 text-right">
            <div className="font-mono font-semibold tabular-nums">
              U$ {universal(detail.breakdown.total)}
            </div>
            <div className="mt-1 font-mono font-semibold text-destructive">
              {validation.blockers}
            </div>
          </div>
        </div>
        <div className="border-t px-5 py-3 text-xs text-muted-foreground">
          {visibleNodes.length} visible row
          {visibleNodes.length === 1 ? "" : "s"} · costs include each row’s quantity; exact decimals are retained;
          display values are rounded to two places.
        </div>
      </div>
      <RecordInspector
        node={inspectedNode}
        directBlockers={inspectedDirectBlockers}
        scopeBlockers={inspectedBlockers}
        carBlockers={validation.blockers}
        costedParts={inspectedCostedParts}
        partCount={inspectedParts.length}
        missingVisuals={inspectedMissingVisuals}
        evidence={inspectedEvidence}
        canWrite={canWrite}
        onEdit={() => inspectedNode && onOpenNode(inspectedNode.id)}
      />
    </div>
  )
}

function collectNodeParts(node: CostNode): CostNode[] {
  if (node.kind === "part") return [node]
  return node.children.flatMap(collectNodeParts)
}

function CostTableHead({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  return (
    <TableHead className={cn("text-center", className)}>
      <span className="block">{label}</span>
      <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
        U$
      </span>
    </TableHead>
  )
}

function MoneyCell({
  value,
  emphasized = false,
}: {
  value: string
  emphasized?: boolean
}) {
  return (
    <TableCell
      className={cn(
        "text-center font-mono text-xs tabular-nums",
        emphasized && "font-semibold text-foreground",
      )}
    >
      {universal(value)}
    </TableCell>
  )
}

function MobileCost({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">
        U$ {universal(value)}
      </span>
    </div>
  )
}

function NodeStatus({
  node,
  issues,
}: {
  node: CostNode
  issues: ValidationIssue[]
}) {
  const blockers = issues.filter((issue) => issue.severity === "blocker")
  const warnings = issues.filter((issue) => issue.severity === "warning")
  const notices = issues.filter((issue) => issue.severity === "notice")
  if (blockers.length > 0) {
    return (
      <Badge
        variant="destructive"
        className="whitespace-nowrap"
        title={blockers.map((issue) => issue.title).join("\n")}
      >
        {blockers[0]?.code === "part-not-costed"
          ? "Needs costing"
          : `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`}
      </Badge>
    )
  }
  if (warnings.length > 0) {
    return (
      <Badge
        className="border-amber-200 bg-amber-50 text-amber-800"
        title={warnings.map((issue) => issue.title).join("\n")}
      >
        {warnings.length} warning{warnings.length === 1 ? "" : "s"}
      </Badge>
    )
  }
  if (notices.length > 0) {
    return (
      <Badge
        className="border-blue-200 bg-blue-50 text-blue-800"
        title={notices.map((issue) => issue.title).join("\n")}
      >
        {notices.length} notice{notices.length === 1 ? "" : "s"}
      </Badge>
    )
  }
  if (
    (node.kind === "system" ||
      node.kind === "assembly" ||
      node.kind === "subassembly") &&
    node.children.length === 0
  ) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Empty
      </Badge>
    )
  }
  return (
    <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">
      Ready
    </Badge>
  )
}

function ImportPage({
  project,
  onViewBom,
}: {
  project: ProjectDetail["project"]
  onViewBom: () => void
}) {
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [recoveryBatchId, setRecoveryBatchId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("batch"),
  )
  const [commitValidOnly, setCommitValidOnly] = useState(false)
  const [commitKey, setCommitKey] = useState(() => crypto.randomUUID())
  const [receipt, setReceipt] = useState<ImportCommitResult | null>(null)
  const [candidatePage, setCandidatePage] = useState(0)
  const [issuePage, setIssuePage] = useState(0)
  const previewHistory = useQuery({
    queryKey: ["imports", project.id, "preview"],
    queryFn: () =>
      api.importBatches(project.id, { status: "preview", limit: 20 }),
  })
  const recoveredPreview = useQuery({
    queryKey: ["import-preview", recoveryBatchId],
    queryFn: () => api.importPreview(recoveryBatchId!),
    enabled: Boolean(recoveryBatchId) && !preview,
  })

  useEffect(() => {
    if (!recoveredPreview.data) return
    setPreview(recoveredPreview.data)
    setFile(null)
    setReceipt(null)
    setCandidatePage(0)
    setIssuePage(0)
  }, [recoveredPreview.data])

  const setImportLocation = (batchId: string | null) => {
    const path = batchId
      ? `/import?batch=${encodeURIComponent(batchId)}`
      : "/import"
    window.history.replaceState(null, "", path)
    setRecoveryBatchId(batchId)
  }

  const upload = useMutation({
    mutationFn: () => api.previewImport(project.id, file!),
    onSuccess: (result) => {
      setPreview(result)
      setImportLocation(result.id)
      setReceipt(null)
      setCandidatePage(0)
      setIssuePage(0)
      toast.success("Read-only import preview created")
    },
    onError: showMutationError,
  })
  const commit = useMutation({
    mutationFn: () =>
      api.commitImport(
        preview!.id,
        preview!.version,
        commitValidOnly,
        commitKey,
      ),
    onSuccess: async (result) => {
      setReceipt(result)
      setPreview((current) =>
        current
          ? {
              ...current,
              status: "committed",
              version: result.version,
              committedAt: result.committedAt,
            }
          : current,
      )
      toast.success(
        `Imported ${result.insertedNodes} nodes; skipped ${result.skippedRows}`,
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace"] }),
        queryClient.invalidateQueries({
          queryKey: ["validation", project.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["imports", project.id],
        }),
      ])
    },
    onError: showMutationError,
  })
  const cancel = useMutation({
    mutationFn: () => api.cancelImport(preview!.id, preview!.version),
    onSuccess: async () => {
      setImportLocation(null)
      setPreview(null)
      setFile(null)
      setReceipt(null)
      setCommitValidOnly(false)
      setCandidatePage(0)
      setIssuePage(0)
      setCommitKey(crypto.randomUUID())
      await queryClient.invalidateQueries({
        queryKey: ["imports", project.id],
      })
      toast.success("Import preview cancelled")
    },
    onError: showMutationError,
  })

  const errorCount =
    preview?.preview.issues.filter((issue) => issue.severity === "error")
      .length ?? 0
  const warningCount =
    preview?.preview.issues.filter((issue) => issue.severity === "warning")
      .length ?? 0
  const candidateRows = preview ? importCandidateRows(preview) : []
  const candidatePageSize = 25
  const issuePageSize = 30
  const visibleCandidates = candidateRows.slice(
    candidatePage * candidatePageSize,
    (candidatePage + 1) * candidatePageSize,
  )
  const visibleIssues =
    preview?.preview.issues.slice(
      issuePage * issuePageSize,
      (issuePage + 1) * issuePageSize,
    ) ?? []

  useUnsavedChangesRegistration(
    `import:${project.id}`,
    Boolean(file) && !preview,
    { label: "Spreadsheet import" },
  )

  const resetImport = () => {
    setImportLocation(null)
    setPreview(null)
    setFile(null)
    setReceipt(null)
    setCommitValidOnly(false)
    setCandidatePage(0)
    setIssuePage(0)
    setCommitKey(crypto.randomUUID())
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader>
          <CardTitle>Staged spreadsheet import</CardTitle>
          <p className="text-sm text-muted-foreground">
            Imports are preview-first. Every raw row and issue is retained
            before any BOM record is created.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {!preview ? (
            <>
              {(previewHistory.data?.batches.length ?? 0) > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">
                    Unfinished previews
                  </h3>
                  {previewHistory.data?.batches.map((batch) => (
                    <div
                      key={batch.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {batch.sourceName}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Created by {batch.createdBy.displayName} ·{" "}
                          {new Date(batch.createdAt).toLocaleString("en-NZ")}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setImportLocation(batch.id)}
                      >
                        Resume preview
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {recoveryBatchId ? (
                recoveredPreview.isError ? (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertTitle>Could not resume preview</AlertTitle>
                    <AlertDescription>
                      <p>
                        {recoveredPreview.error instanceof Error
                          ? recoveredPreview.error.message
                          : "Request failed"}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-3"
                        onClick={() => setImportLocation(null)}
                      >
                        Return to imports
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div
                    className="flex items-center justify-center gap-2 rounded-lg border border-dashed py-16 text-sm text-muted-foreground"
                    role="status"
                  >
                    <LoaderCircle className="size-4 animate-spin" />
                    Loading saved preview…
                  </div>
                )
              ) : (
                <>
                  <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center hover:bg-muted/25">
                    <FileSpreadsheet className="size-10 text-muted-foreground" />
                    <span className="mt-4 font-medium">
                      Choose a CSV exported from the team workbook
                    </span>
                    <span className="mt-1 max-w-md text-sm text-muted-foreground">
                      Supported structures: the legacy master-parts sheet and
                      the 2026 assembly index. Formula catalogue XLSX files are
                      pinned separately and are not treated as team BOM imports.
                    </span>
                    <Input
                      type="file"
                      accept=".csv,text/csv"
                      className="sr-only"
                      onChange={(event) => {
                        setFile(event.target.files?.[0] ?? null)
                      }}
                    />
                    {file && (
                      <Badge variant="outline" className="mt-4">
                        {file.name}
                      </Badge>
                    )}
                  </label>
                  <div className="flex justify-end">
                    <Button
                      onClick={() => upload.mutate()}
                      disabled={!file || upload.isPending}
                    >
                      {upload.isPending ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Upload />
                      )}
                      Create preview
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-4">
                <div>
                  <div className="font-medium">{preview.sourceName}</div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    SHA-256 {preview.sourceSha256}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Badge variant="outline">{preview.preview.template}</Badge>
                  <Badge variant="outline">{preview.preview.encoding}</Badge>
                </div>
              </div>

              {receipt && (
                <Alert className="border-emerald-300 bg-emerald-50 text-emerald-950">
                  <Check className="text-emerald-700" />
                  <AlertTitle>
                    {receipt.alreadyCommitted
                      ? "Import already committed"
                      : "Import committed"}
                  </AlertTitle>
                  <AlertDescription>
                    <p>
                      {receipt.alreadyCommitted
                        ? "The server recognised this completed batch and did not create duplicate nodes."
                        : "The reviewed preview is now part of the editable BOM hierarchy."}
                    </p>
                    <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                      <div>
                        <dt className="text-emerald-900/70">Source</dt>
                        <dd className="font-medium">{preview.sourceName}</dd>
                      </div>
                      <div>
                        <dt className="text-emerald-900/70">Completed</dt>
                        <dd className="font-medium">
                          {new Date(receipt.committedAt).toLocaleString(
                            "en-NZ",
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-emerald-900/70">Inserted nodes</dt>
                        <dd className="font-medium">
                          {receipt.insertedNodes}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-emerald-900/70">Skipped rows</dt>
                        <dd className="font-medium">
                          {receipt.skippedRows}
                        </dd>
                      </div>
                    </dl>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button size="sm" onClick={onViewBom}>
                        View imported items
                        <ChevronRight />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={resetImport}
                      >
                        Import another file
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <StatCard
                  label="Candidate records"
                  value={String(
                    preview.preview.records?.length ??
                      preview.preview.claims?.length ??
                      0,
                  )}
                />
                <StatCard
                  label="Errors"
                  value={String(errorCount)}
                  danger={errorCount > 0}
                />
                <StatCard label="Warnings" value={String(warningCount)} />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="font-semibold">Candidate records</h3>
                  <span className="text-xs text-muted-foreground">
                    {candidateRows.length} total
                  </span>
                </div>
                {candidateRows.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No importable records were detected in this file.
                  </div>
                ) : (
                  <>
                    <Table
                      className="min-w-[680px]"
                      containerClassName="rounded-lg border"
                      containerProps={{
                        role: "region",
                        "aria-label": "Import candidate records",
                        tabIndex: 0,
                      }}
                    >
                      <TableHeader>
                        <TableRow className="bg-muted/35">
                          <TableHead className="w-16">Row</TableHead>
                          <TableHead className="w-28">Type</TableHead>
                          <TableHead>Identifier</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead className="w-24">System</TableHead>
                          <TableHead className="w-20 text-right">
                            Qty
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleCandidates.map((candidate) => (
                          <TableRow key={candidate.rowNumber}>
                            <TableCell className="tabular-nums">
                              {candidate.rowNumber}
                            </TableCell>
                            <TableCell className="capitalize">
                              {candidate.kind}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {candidate.identifier || "—"}
                            </TableCell>
                            <TableCell>{candidate.name || "Unnamed"}</TableCell>
                            <TableCell>{candidate.system || "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {candidate.quantity ?? "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <PaginationControls
                      label="Candidate records"
                      page={candidatePage}
                      pageSize={candidatePageSize}
                      total={candidateRows.length}
                      onPageChange={setCandidatePage}
                    />
                  </>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-semibold">Detected issues</h3>
                  <span className="text-xs text-muted-foreground">
                    {preview.preview.issues.length} total
                  </span>
                </div>
                <div className="max-h-[420px] divide-y overflow-y-auto rounded-lg border">
                  {preview.preview.issues.length === 0 ? (
                    <div className="flex items-center gap-2 p-4 text-sm text-emerald-700">
                      <Check className="size-4" />
                      No parser issues detected.
                    </div>
                  ) : (
                    visibleIssues.map((issue, index) => (
                      <div
                        key={`${issue.code}-${issue.rowNumber ?? index}`}
                        className="flex items-start gap-3 p-3"
                      >
                        {issue.severity === "error" ? (
                          <X className="mt-0.5 size-4 shrink-0 text-destructive" />
                        ) : issue.severity === "warning" ? (
                          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                        ) : (
                          <Info className="mt-0.5 size-4 shrink-0 text-blue-600" />
                        )}
                        <div className="min-w-0">
                          <div className="text-sm font-medium">
                            {issue.message}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {issue.code}
                            {issue.rowNumber
                              ? ` · source row ${issue.rowNumber}`
                              : ""}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                {preview.preview.issues.length > 0 && (
                  <PaginationControls
                    label="Detected issues"
                    page={issuePage}
                    pageSize={issuePageSize}
                    total={preview.preview.issues.length}
                    onPageChange={setIssuePage}
                  />
                )}
              </div>

              {!receipt && errorCount > 0 && (
                <label className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
                  <input
                    type="checkbox"
                    checked={commitValidOnly}
                    onChange={(event) =>
                      setCommitValidOnly(event.target.checked)
                    }
                    className="mt-0.5 size-4 accent-[#b51031]"
                  />
                  <span>
                    <span className="block font-medium">
                      Commit only valid rows
                    </span>
                    <span className="mt-1 block text-amber-900/75">
                      Invalid rows will be preserved as skipped import records.
                      They will not be silently repaired.
                    </span>
                  </span>
                </label>
              )}

              {!receipt && (
                <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-between">
                  <Button
                    variant="outline"
                    onClick={() => cancel.mutate()}
                    disabled={cancel.isPending || commit.isPending}
                  >
                    {cancel.isPending && (
                      <LoaderCircle className="animate-spin" />
                    )}
                    Cancel preview
                  </Button>
                  <Button
                    onClick={() => commit.mutate()}
                    disabled={
                      commit.isPending ||
                      cancel.isPending ||
                      preview.status === "committed" ||
                      (errorCount > 0 && !commitValidOnly)
                    }
                  >
                    {commit.isPending && (
                      <LoaderCircle className="animate-spin" />
                    )}
                    Commit reviewed preview
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What the importer preserves</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <PreservedItem text="Source filename, SHA-256 hash, and parsed row provenance" />
            <PreservedItem text="Every raw row, including unnamed legacy columns" />
            <PreservedItem text="Original HLA, subassembly, variant, revision, and statuses" />
            <PreservedItem text="Errors and candidate records before commit" />
          </CardContent>
        </Card>
        <Alert>
          <Hash />
          <AlertTitle>No part-number guessing</AlertTitle>
          <AlertDescription>
            Legacy identifiers are retained as raw fields. Full 2026 numbers
            stay blank until the team confirms its current grammar.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  )
}

interface ImportCandidateRow {
  rowNumber: number
  kind: string
  identifier: string
  name: string
  system: string
  quantity: number | null
}

function importCandidateRows(preview: ImportPreview): ImportCandidateRow[] {
  if (preview.preview.records) {
    return preview.preview.records.map((record) => ({
      rowNumber: record.provenance.rowNumber,
      kind: record.recordKind,
      identifier: record.partNumber || record.sourceKey || "",
      name:
        record.recordKind === "assembly"
          ? record.assemblyName ?? ""
          : record.componentName ?? "",
      system: record.system ?? "",
      quantity: record.quantityOnCar,
    }))
  }

  return (preview.preview.claims ?? []).map((claim) => ({
    rowNumber: claim.provenance.rowNumber,
    kind: "assembly",
    identifier: claim.sourceKey,
    name: claim.assemblyName ?? "",
    system: claim.system,
    quantity: 1,
  }))
}

function PaginationControls({
  label,
  page,
  pageSize,
  total,
  onPageChange,
}: {
  label: string
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : page * pageSize + 1
  const last = Math.min(total, (page + 1) * pageSize)

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
      <span aria-live="polite">
        {first}–{last} of {total}
      </span>
      <div className="flex gap-2" aria-label={`${label} pages`}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page === 0}
        >
          Previous
        </Button>
        <span className="self-center px-1">
          Page {page + 1} of {pageCount}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount - 1}
        >
          Next
        </Button>
      </div>
    </div>
  )
}

function ValidationPage({
  detail,
  validation,
  canWrite,
  onOpenTarget,
  onContextChange,
}: {
  detail: ProjectDetail
  validation: ValidationResult
  canWrite: boolean
  onOpenTarget: (target: ValidationIssueTarget) => void
  onContextChange: (filter: ValidationFilter, page: number) => void
}) {
  const [filter, setFilter] = useState<ValidationFilter>(
    validationFilterFromLocation,
  )
  const [page, setPage] = useState(validationPageFromLocation)
  const pageSize = 20
  const issues = validation.issues.filter(
    (issue) => filter === "all" || issue.severity === filter,
  )
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(issues.length / pageSize) - 1),
  )
  const visibleIssues = issues.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  )
  const nodeNames = new Map(
    detail.flatNodes.map((node) => [node.id, node.name]),
  )
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <ValidationCount
          label="Blockers"
          value={validation.blockers}
          icon={ShieldAlert}
          tone="red"
        />
        <ValidationCount
          label="Warnings"
          value={validation.warnings}
          icon={AlertTriangle}
          tone="amber"
        />
        <ValidationCount
          label="Notices"
          value={validation.notices}
          icon={Info}
          tone="blue"
        />
      </div>

      <CriticalDatasheetPanel
        key={`${detail.project.id}:${detail.project.vehicle_type}`}
        projectId={detail.project.id}
        vehicleType={detail.project.vehicle_type}
        canWrite={canWrite}
      />

      <Card>
        <CardHeader className="gap-4 md:flex-row md:items-center">
          <div className="flex-1">
            <CardTitle>Competition report checks</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Checks are tied to the pinned local addendum and catalogue. They
              do not fabricate unpublished scoring multipliers.
            </p>
          </div>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Filter validation findings"
          >
            {(["all", "blocker", "warning", "notice"] as const).map(
              (option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={filter === option ? "default" : "outline"}
                  onClick={() => {
                    setFilter(option)
                    setPage(0)
                    onContextChange(option, 0)
                  }}
                  className="capitalize"
                  aria-pressed={filter === option}
                >
                  {option}
                </Button>
              ),
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {issues.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <PackageCheck className="mx-auto size-8 text-emerald-700" />
              <p className="mt-3 text-sm font-medium">
                No {filter === "all" ? "validation" : filter} findings
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose another filter to review the remaining checks.
              </p>
            </div>
          ) : (
            visibleIssues.map((issue) => {
              const target = resolveValidationIssueTarget(issue)
              return (
                <div
                  key={issue.id}
                  className={cn(
                    "rounded-lg border p-4",
                    issue.severity === "blocker" &&
                      "border-red-200 bg-red-50/60",
                    issue.severity === "warning" &&
                      "border-amber-200 bg-amber-50/60",
                    issue.severity === "notice" &&
                      "border-blue-200 bg-blue-50/50",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <IssueIcon severity={issue.severity} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{issue.title}</span>
                        <Badge variant="outline" className="capitalize">
                          {issue.severity}
                        </Badge>
                      </div>
                      {issue.nodeId && (
                        <div className="mt-1 text-xs font-medium text-muted-foreground">
                          {nodeNames.get(issue.nodeId) ?? issue.nodeId}
                        </div>
                      )}
                      <p className="mt-2 text-sm text-muted-foreground">
                        {issue.detail}
                      </p>
                      {issue.ruleReference && (
                        <div className="mt-3 font-mono text-[11px] text-muted-foreground">
                          {issue.ruleReference}
                        </div>
                      )}
                      {target && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="mt-4"
                          onClick={() => onOpenTarget(target)}
                        >
                          {target.actionLabel}
                          <ChevronRight />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}
          {issues.length > 0 && (
            <PaginationControls
              label="Validation findings"
              page={safePage}
              pageSize={pageSize}
              total={issues.length}
              onPageChange={(nextPage) => {
                setPage(nextPage)
                onContextChange(filter, nextPage)
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

const electricDatasheets = [
  ["cells", "Cell datasheet"],
  ["bms", "Battery-management system datasheet"],
  ["motors", "Motor datasheet"],
  ["motor-controllers", "Motor-controller datasheet"],
  ["main-controller", "Main VCU or ECU datasheet"],
  ["lv-battery", "Low-voltage battery datasheet"],
] as const

const combustionDatasheets = [
  ["engine", "Engine datasheet"],
  ["ecu", "Engine-control unit (ECU) datasheet"],
  ["injectors", "Fuel-injector datasheet"],
] as const

const dualDatasheets = [
  ...electricDatasheets,
  ...combustionDatasheets,
] as const

function criticalDatasheetsFor(
  vehicleType: ProjectSummary["vehicle_type"],
) {
  if (vehicleType === "electric") return electricDatasheets
  if (vehicleType === "combustion") return combustionDatasheets
  return dualDatasheets
}

function CriticalDatasheetPanel({
  projectId,
  vehicleType,
  canWrite,
}: {
  projectId: string
  vehicleType: ProjectSummary["vehicle_type"]
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const requiredDatasheets = criticalDatasheetsFor(vehicleType)
  const [tag, setTag] = useState<CriticalDatasheetTag>(
    () => requiredDatasheets[0][0],
  )
  const [file, setFile] = useState<File | null>(null)
  const evidence = useQuery({
    queryKey: ["evidence", projectId],
    queryFn: () => api.evidence(projectId),
  })
  const attachedTags = new Set(
    (evidence.data?.evidence ?? [])
      .filter(
        (item) =>
          item.kind === "datasheet" && item.visibility === "report",
      )
      .flatMap(
        (item) =>
          item.report_caption.match(/\[(.+?)\]/g)?.map((value) =>
            value.slice(1, -1).toLowerCase(),
          ) ?? [],
      ),
  )
  const projectDatasheets =
    evidence.data?.evidence.filter(
      (item) => item.kind === "datasheet" && item.node_id === null,
    ) ?? []
  const selectedLabel =
    requiredDatasheets.find(([candidate]) => candidate === tag)?.[1] ??
    "Critical datasheet"

  useUnsavedChangesRegistration(
    `critical-datasheet:${projectId}`,
    Boolean(file),
    { label: "Critical datasheet upload" },
  )

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get(
      "datasheet",
    )
    if (
      requested &&
      requiredDatasheets.some(
        ([candidate]) => candidate === requested,
      )
    ) {
      setTag(requested as CriticalDatasheetTag)
    }
  }, [projectId, requiredDatasheets])

  const uploadDatasheet = useMutation({
    mutationFn: () =>
      api.uploadEvidence(projectId, file!, {
        kind: "datasheet",
        reportCaption: `[${tag}] ${selectedLabel}`,
      }),
    onSuccess: async () => {
      toast.success(`${selectedLabel} attached`)
      setFile(null)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["evidence", projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["validation", projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["reports", projectId],
        }),
      ])
    },
    onError: showMutationError,
  })

  return (
    <Card
      id="critical-datasheets"
      tabIndex={-1}
      className="outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-4"
    >
      <CardHeader>
        <CardTitle>
          Critical{" "}
          {vehicleType === "electric"
            ? "electric-vehicle"
            : vehicleType === "combustion"
              ? "combustion-vehicle"
              : "dual-powertrain"}{" "}
          datasheets
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Local Addendum S.3.4.1 requires the report appendix to contain these{" "}
          {requiredDatasheets.length} source categories
          {vehicleType === "dual"
            ? " (six electric and three combustion)"
            : ""}
          . Uploads below are tagged explicitly and appended to the generated
          PDF.
        </p>
      </CardHeader>
      <CardContent>
        {evidence.isError && (
          <QueryError
            error={evidence.error}
            title="Could not load attached datasheets"
            onRetry={() => evidence.refetch()}
            isRetrying={evidence.isFetching}
            compact
            className="mb-4"
          />
        )}
        {(!evidence.isError || evidence.data) && (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {requiredDatasheets.map(([requiredTag, label]) => {
            const attached = attachedTags.has(requiredTag)
            return (
              <div
                key={requiredTag}
                className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
              >
                {attached ? (
                  <Check className="size-4 shrink-0 text-emerald-700" />
                ) : (
                  <CircleAlert className="size-4 shrink-0 text-amber-700" />
                )}
                <span className="min-w-0 flex-1 text-sm">{label}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    attached && "border-emerald-200 text-emerald-700",
                  )}
                >
                  {attached ? "Attached" : "Missing"}
                </Badge>
              </div>
            )
          })}
          </div>
        )}
        <div className="mt-5 grid items-end gap-3 md:grid-cols-[240px_1fr_auto]">
          <FormField label="Datasheet category">
            <Select
              value={tag}
              disabled={!canWrite}
              onValueChange={(value) =>
                setTag(
                  value as (typeof electricDatasheets)[number][0],
                )
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {requiredDatasheets.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="PDF or image">
            <Input
              key={file?.name ?? "empty-datasheet"}
              type="file"
              disabled={!canWrite}
              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
              onChange={(event) =>
                setFile(event.target.files?.[0] ?? null)
              }
            />
          </FormField>
          <Button
            onClick={() => uploadDatasheet.mutate()}
            disabled={!canWrite || !file || uploadDatasheet.isPending}
          >
            {uploadDatasheet.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Upload />
            )}
            Attach
          </Button>
        </div>
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold">Attached files</h3>
          {evidence.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : evidence.data ? (
            <EvidenceList
              items={projectDatasheets}
              projectId={projectId}
              canWrite={canWrite}
              emptyMessage="No vehicle-level datasheets attached yet."
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

function SourcesPage({ meta }: { meta: Meta }) {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card
        id="governing-sources"
        tabIndex={-1}
        className="outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-4"
      >
        <CardHeader>
          <CardTitle>Governing sources</CardTitle>
          <p className="text-sm text-muted-foreground">
            Active rule pack {meta.rulePack.version} is identified by SHA-256{" "}
            <code className="break-all text-xs">{meta.rulePack.sha256}</code>.
            This page only exposes sources already attached to that pack; it
            does not import, stage, or activate newer releases.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {meta.sourceDocuments.map((source) => {
            const sourceUrl =
              source.downloadUrl || trustedSourceUrl(source)
            const servesArchivedCopy = Boolean(source.downloadUrl)
            return (
              <div key={source.sha256} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{source.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {source.kind} · {source.version}
                    </div>
                  </div>
                  <Badge variant="outline">Pinned</Badge>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  {source.applicability}
                </p>
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <code className="min-w-0 flex-1 break-all rounded bg-muted px-2.5 py-2 text-[11px]">
                    SHA-256 {source.sha256}
                  </code>
                  {sourceUrl ? (
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={sourceUrl}
                        target={servesArchivedCopy ? undefined : "_blank"}
                        rel={
                          servesArchivedCopy
                            ? undefined
                            : "noreferrer noopener"
                        }
                        aria-label={`${servesArchivedCopy ? "Download archived copy of" : "Open official source for"} ${source.title}`}
                      >
                        <Download />
                        {servesArchivedCopy
                          ? "Download archived copy"
                          : "Open official source"}
                      </a>
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No trusted source URL
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Hard guardrails</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {meta.guardrails.map((guardrail) => (
              <div key={guardrail} className="flex items-start gap-2 text-sm">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-700" />
                <span>{guardrail}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Alert
          id="committee-confirmation"
          tabIndex={-1}
          className="border-amber-300 bg-amber-50 outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-4"
        >
          <AlertTriangle className="text-amber-700" />
          <AlertTitle>Committee confirmation still required</AlertTitle>
          <AlertDescription>
            Current documents conflict on late-submission windows and the
            amendment route; the current D1–D4 and A mappings are unpublished.
            The app exposes these gaps and does not guess.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  )
}

function ValidationCount({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string
  value: number
  icon: typeof ShieldAlert
  tone: "red" | "amber" | "blue"
}) {
  const styles = {
    red: "bg-red-100 text-red-700",
    amber: "bg-amber-100 text-amber-700",
    blue: "bg-blue-100 text-blue-700",
  }
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className={cn("grid size-11 place-items-center rounded-lg", styles[tone])}>
          <Icon className="size-5" />
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
          <div className="text-sm text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function IssueIcon({ severity }: { severity: ValidationIssue["severity"] }) {
  if (severity === "blocker") {
    return <ShieldAlert className="mt-0.5 size-5 shrink-0 text-red-700" />
  }
  if (severity === "warning") {
    return <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700" />
  }
  return <Info className="mt-0.5 size-5 shrink-0 text-blue-700" />
}

function FormField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  )
}

function StatCard({
  label,
  value,
  danger = false,
}: {
  label: string
  value: string
  danger?: boolean
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className={cn("text-2xl font-semibold", danger && "text-destructive")}>
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function PreservedItem({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <Check className="mt-0.5 size-4 shrink-0 text-emerald-700" />
      <span>{text}</span>
    </div>
  )
}

function PageSkeleton({ label = "Loading page" }: { label?: string }) {
  return (
    <div
      className="space-y-5"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <span className="sr-only">{label}</span>
      <Skeleton className="h-16 w-full" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Skeleton className="h-[620px]" />
        <div className="space-y-5">
          <Skeleton className="h-72" />
          <Skeleton className="h-64" />
        </div>
      </div>
    </div>
  )
}

function NodeEditorSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading item editor">
      <Skeleton className="h-9 w-52" />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="h-4 w-full max-w-2xl" />
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-24 sm:col-span-2" />
        </CardContent>
      </Card>
    </div>
  )
}

function FatalError({
  error,
  onRetry,
  compact = false,
}: {
  error: unknown
  onRetry: () => void
  compact?: boolean
}) {
  const message =
    error instanceof Error ? error.message : "The application could not load."
  return (
    <div
      className={cn(
        "grid min-h-screen place-items-center bg-muted/30 p-6",
        compact && "min-h-[420px]",
      )}
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="grid size-10 place-items-center rounded-lg bg-red-100 text-red-700">
            <CircleAlert className="size-5" />
          </div>
          <CardTitle asChild>
            <h1>Could not load costing data</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{message}</p>
          <Button className="mt-4" onClick={onRetry}>
            Retry
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function flattenTree(
  root: CostNode,
  expanded: Set<string>,
  depth = -1,
): Array<{ node: CostNode; depth: number }> {
  const rows = [{ node: root, depth: Math.max(depth, 0) }]
  if (!expanded.has(root.id)) return rows
  for (const child of root.children) {
    rows.push(...flattenTree(child, expanded, depth + 1))
  }
  return rows
}

function showMutationError(error: unknown) {
  if (error instanceof ApiError) {
    toast.error(error.message)
    return
  }
  toast.error(error instanceof Error ? error.message : "Request failed")
}
