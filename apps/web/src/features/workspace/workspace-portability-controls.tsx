import { useMemo, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { canCreateChild } from "@ucm/domain"
import { Archive, Copy, Download, LoaderCircle, Upload } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  api,
  type CostNode,
  type HistoricalProjectPreview,
  type ProjectArchivePreview,
  type ProjectCopyPreview,
  type ProjectDetail,
  type ProjectSummary,
} from "@/lib/api"

export function WorkspacePortabilityControls({
  detail,
  projects,
  selectedNode,
  role,
  onOpenWorkspace,
}: {
  detail: ProjectDetail
  projects: ProjectSummary[]
  selectedNode: CostNode | null
  role: "admin" | "editor" | "viewer"
  onOpenWorkspace: (projectId: string, nodeId?: string) => void
}) {
  const [toolsOpen, setToolsOpen] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const currentTarget = projects.find((project) => !project.is_historical)
  const copyAvailable =
    role !== "viewer" &&
    detail.project.is_historical &&
    Boolean(currentTarget) &&
    Boolean(
      selectedNode &&
        ["assembly", "subassembly", "part"].includes(selectedNode.kind),
    )

  return (
    <>
      {copyAvailable && selectedNode && currentTarget && (
        <Button
          variant="outline"
          aria-label={`Copy selection to ${currentTarget.season}`}
          onClick={() => setCopyOpen(true)}
        >
          <Copy />
          <span className="hidden xl:inline">Copy to {currentTarget.season}</span>
        </Button>
      )}
      <Button
        variant="outline"
        size="icon"
        aria-label="Workspace files and season tools"
        onClick={() => setToolsOpen(true)}
      >
        <Archive />
      </Button>
      <WorkspaceFilesDialog
        open={toolsOpen}
        onOpenChange={setToolsOpen}
        project={detail.project}
        projects={projects}
        isAdmin={role === "admin"}
        onOpenWorkspace={onOpenWorkspace}
      />
      {selectedNode && currentTarget && (
        <CopyToCurrentDialog
          open={copyOpen}
          onOpenChange={setCopyOpen}
          sourceProject={detail.project}
          sourceNode={selectedNode}
          targetProject={currentTarget}
          onOpenWorkspace={onOpenWorkspace}
        />
      )}
    </>
  )
}

function WorkspaceFilesDialog({
  open,
  onOpenChange,
  project,
  projects,
  isAdmin,
  onOpenWorkspace,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ProjectSummary
  projects: ProjectSummary[]
  isAdmin: boolean
  onOpenWorkspace: (projectId: string) => void
}) {
  const queryClient = useQueryClient()
  const [historicalFile, setHistoricalFile] = useState<File | null>(null)
  const [historicalSeason, setHistoricalSeason] = useState(() =>
    Math.max(2020, Math.min(...projects.map(({ season }) => season)) - 1),
  )
  const [historicalName, setHistoricalName] = useState(
    `UC Motorsport ${historicalSeason}`,
  )
  const [historicalEntry, setHistoricalEntry] = useState(project.entry_number)
  const [historicalVehicleType, setHistoricalVehicleType] =
    useState<ProjectSummary["vehicle_type"]>(project.vehicle_type)
  const [historicalPreview, setHistoricalPreview] =
    useState<HistoricalProjectPreview | null>(null)

  const [archiveFile, setArchiveFile] = useState<File | null>(null)
  const [archiveSeason, setArchiveSeason] = useState(
    () => Math.max(...projects.map(({ season }) => season)) + 1,
  )
  const [archiveName, setArchiveName] = useState("Restored UCM workspace")
  const [archiveEntry, setArchiveEntry] = useState(project.entry_number)
  const [archiveHistorical, setArchiveHistorical] = useState(false)
  const [archivePreview, setArchivePreview] =
    useState<ProjectArchivePreview | null>(null)

  const downloadArchive = useMutation({
    mutationFn: () => api.downloadProjectArchive(project.id),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = filename
      anchor.click()
      URL.revokeObjectURL(url)
      toast.success("Workspace archive downloaded")
    },
    onError: showError,
  })

  const previewHistorical = useMutation({
    mutationFn: () =>
      api.previewHistoricalProject(historicalFile!, {
        season: historicalSeason,
        name: historicalName,
        entryNumber: historicalEntry,
        vehicleType: historicalVehicleType,
      }),
    onSuccess: setHistoricalPreview,
    onError: showError,
  })
  const commitHistorical = useMutation({
    mutationFn: () =>
      api.commitHistoricalProject(historicalFile!, {
        season: historicalSeason,
        name: historicalName,
        entryNumber: historicalEntry,
        vehicleType: historicalVehicleType,
        expectedSourceSha256: historicalPreview!.sourceSha256,
        idempotencyKey: newIdempotencyKey("historical"),
      }),
    onSuccess: async ({ project: created }) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] })
      toast.success(`Historical ${created.season} workspace imported`)
      onOpenChange(false)
      onOpenWorkspace(created.id)
    },
    onError: showError,
  })

  const previewArchive = useMutation({
    mutationFn: () =>
      api.previewProjectArchive(archiveFile!, {
        targetSeason: archiveSeason,
        targetName: archiveName,
        targetEntryNumber: archiveEntry,
        targetIsHistorical: archiveHistorical,
      }),
    onSuccess: setArchivePreview,
    onError: showError,
  })
  const commitArchive = useMutation({
    mutationFn: () =>
      api.commitProjectArchive(archiveFile!, {
        targetSeason: archiveSeason,
        targetName: archiveName,
        targetEntryNumber: archiveEntry,
        targetIsHistorical: archiveHistorical,
        expectedArchiveSha256: archivePreview!.archiveSha256,
        previewHash: archivePreview!.previewHash,
        idempotencyKey: newIdempotencyKey("archive"),
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] })
      toast.success(`Season ${result.season} restored from archive`)
      onOpenChange(false)
      onOpenWorkspace(result.projectId)
    },
    onError: showError,
  })

  const historicalChanged = () => setHistoricalPreview(null)
  const archiveChanged = () => setArchivePreview(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Workspace files and seasons</DialogTitle>
          <DialogDescription>
            Export a portable costing workspace. Administrators can preview and
            restore archives or import a historical master-parts CSV.
          </DialogDescription>
        </DialogHeader>

        <section className="rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-medium">Portable workspace archive</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Includes settings, hierarchy, cost lines, and verified evidence.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => downloadArchive.mutate()}
              disabled={downloadArchive.isPending}
            >
              {downloadArchive.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Download />
              )}
              Download {project.season}
            </Button>
          </div>
        </section>

        {isAdmin && (
          <>
            <section className="space-y-4 rounded-lg border p-4">
              <div>
                <h3 className="font-medium">Import historical season</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  The CSV import is hierarchy-only and the resulting season is
                  permanently read-only.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Master-parts CSV">
                  <Input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => {
                      setHistoricalFile(event.target.files?.[0] ?? null)
                      historicalChanged()
                    }}
                  />
                </Field>
                <Field label="Season">
                  <Input
                    type="number"
                    min={2020}
                    max={2100}
                    value={historicalSeason}
                    onChange={(event) => {
                      const season = Number(event.target.value)
                      setHistoricalSeason(season)
                      setHistoricalName(`UC Motorsport ${season}`)
                      historicalChanged()
                    }}
                  />
                </Field>
                <Field label="Workspace name">
                  <Input
                    value={historicalName}
                    onChange={(event) => {
                      setHistoricalName(event.target.value)
                      historicalChanged()
                    }}
                  />
                </Field>
                <Field label="Entry number">
                  <Input
                    value={historicalEntry}
                    onChange={(event) => {
                      setHistoricalEntry(event.target.value)
                      historicalChanged()
                    }}
                  />
                </Field>
                <Field label="Vehicle type">
                  <Select
                    value={historicalVehicleType}
                    onValueChange={(value: ProjectSummary["vehicle_type"]) => {
                      setHistoricalVehicleType(value)
                      historicalChanged()
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="electric">Electric</SelectItem>
                      <SelectItem value="combustion">Combustion</SelectItem>
                      <SelectItem value="dual">Dual</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Button
                variant="outline"
                onClick={() => previewHistorical.mutate()}
                disabled={!historicalFile || previewHistorical.isPending}
              >
                {previewHistorical.isPending && <LoaderCircle className="animate-spin" />}
                Preview historical import
              </Button>
              {historicalPreview && (
                <PreviewPanel
                  title={`${historicalPreview.candidates} hierarchy candidates`}
                  badges={[
                    `${historicalPreview.errors} errors`,
                    `${historicalPreview.warnings} warnings`,
                  ]}
                  messages={historicalPreview.limitations}
                >
                  <Button
                    onClick={() => commitHistorical.mutate()}
                    disabled={commitHistorical.isPending}
                  >
                    {commitHistorical.isPending && <LoaderCircle className="animate-spin" />}
                    Import valid rows as read-only
                  </Button>
                </PreviewPanel>
              )}
            </section>

            <section className="space-y-4 rounded-lg border p-4">
              <div>
                <h3 className="font-medium">Restore portable archive</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Preview validates the ZIP and makes no database or file changes.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="UCM archive">
                  <Input
                    type="file"
                    accept=".zip,.ucm.zip,application/zip"
                    onChange={(event) => {
                      setArchiveFile(event.target.files?.[0] ?? null)
                      archiveChanged()
                    }}
                  />
                </Field>
                <Field label="Target season">
                  <Input
                    type="number"
                    min={2020}
                    max={2100}
                    value={archiveSeason}
                    onChange={(event) => {
                      setArchiveSeason(Number(event.target.value))
                      archiveChanged()
                    }}
                  />
                </Field>
                <Field label="Workspace name">
                  <Input
                    value={archiveName}
                    onChange={(event) => {
                      setArchiveName(event.target.value)
                      archiveChanged()
                    }}
                  />
                </Field>
                <Field label="Entry number">
                  <Input
                    value={archiveEntry}
                    onChange={(event) => {
                      setArchiveEntry(event.target.value)
                      archiveChanged()
                    }}
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={archiveHistorical}
                  onChange={(event) => {
                    setArchiveHistorical(event.target.checked)
                    archiveChanged()
                  }}
                />
                Restore as a read-only historical workspace
              </label>
              <Button
                variant="outline"
                onClick={() => previewArchive.mutate()}
                disabled={!archiveFile || previewArchive.isPending}
              >
                {previewArchive.isPending && <LoaderCircle className="animate-spin" />}
                Preview archive restore
              </Button>
              {archivePreview && (
                <PreviewPanel
                  title={`${archivePreview.totals.nodes} nodes · ${archivePreview.totals.costLines} cost lines · ${archivePreview.totals.evidence} evidence files`}
                  badges={[
                    `${archivePreview.conflicts.length} conflicts`,
                    formatBytes(archivePreview.totals.evidenceBytes),
                  ]}
                  messages={[...archivePreview.conflicts, ...archivePreview.warnings]}
                  destructive={archivePreview.conflicts.length > 0}
                >
                  <Button
                    onClick={() => commitArchive.mutate()}
                    disabled={
                      archivePreview.conflicts.length > 0 ||
                      commitArchive.isPending
                    }
                  >
                    {commitArchive.isPending && <LoaderCircle className="animate-spin" />}
                    Restore workspace
                  </Button>
                </PreviewPanel>
              )}
            </section>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CopyToCurrentDialog({
  open,
  onOpenChange,
  sourceProject,
  sourceNode,
  targetProject,
  onOpenWorkspace,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceProject: ProjectSummary
  sourceNode: CostNode
  targetProject: ProjectSummary
  onOpenWorkspace: (projectId: string, nodeId?: string) => void
}) {
  const queryClient = useQueryClient()
  const targetDetail = useQuery({
    queryKey: ["workspace", targetProject.id],
    queryFn: () => api.project(targetProject.id),
    enabled: open,
  })
  const eligibleParents = useMemo(
    () =>
      targetDetail.data?.flatNodes.filter((node) =>
        canCreateChild(node.kind, sourceNode.kind),
      ) ?? [],
    [sourceNode.kind, targetDetail.data?.flatNodes],
  )
  const preferredParent =
    eligibleParents.find(
      (node) => node.system_code && node.system_code === sourceNode.system_code,
    ) ?? eligibleParents[0]
  const [targetParentId, setTargetParentId] = useState("")
  const [includeDescendants, setIncludeDescendants] = useState(true)
  const [copyEvidence, setCopyEvidence] = useState(false)
  const [preview, setPreview] = useState<ProjectCopyPreview | null>(null)

  const effectiveTargetParentId = eligibleParents.some(
    ({ id }) => id === targetParentId,
  )
    ? targetParentId
    : preferredParent?.id ?? ""

  const request = {
    sourceProjectId: sourceProject.id,
    sourceNodeId: sourceNode.id,
    targetProjectId: targetProject.id,
    targetParentId: effectiveTargetParentId,
    includeDescendants,
    copyEvidence,
  }
  const createPreview = useMutation({
    mutationFn: () => api.previewProjectCopy(request),
    onSuccess: setPreview,
    onError: showError,
  })
  const commit = useMutation({
    mutationFn: () =>
      api.commitProjectCopy({
        ...request,
        previewHash: preview!.previewHash,
        idempotencyKey: newIdempotencyKey("copy"),
      }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace", targetProject.id] }),
        queryClient.invalidateQueries({ queryKey: ["validation", targetProject.id] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ])
      toast.success(`Copied ${result.createdNodeIds.length} record(s) to ${targetProject.season}`)
      onOpenChange(false)
      onOpenWorkspace(targetProject.id, result.rootNodeId)
    },
    onError: showError,
  })
  const resetPreview = () => setPreview(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Copy {sourceNode.name} to {targetProject.season}</DialogTitle>
          <DialogDescription>
            The source remains unchanged. New records retain lineage and require
            target-season review.
          </DialogDescription>
        </DialogHeader>
        {targetDetail.isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <LoaderCircle className="animate-spin" /> Loading target hierarchy…
          </div>
        ) : targetDetail.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load target workspace</AlertTitle>
            <AlertDescription>{targetDetail.error.message}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            <Field label="Target parent">
              <Select
                value={effectiveTargetParentId}
                onValueChange={(value) => {
                  setTargetParentId(value)
                  resetPreview()
                }}
              >
                <SelectTrigger><SelectValue placeholder="Choose a target parent" /></SelectTrigger>
                <SelectContent>
                  {eligibleParents.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.full_number ?? node.name} · {node.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeDescendants}
                onChange={(event) => {
                  setIncludeDescendants(event.target.checked)
                  resetPreview()
                }}
              />
              Include descendants
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={copyEvidence}
                onChange={(event) => {
                  setCopyEvidence(event.target.checked)
                  resetPreview()
                }}
              />
              Copy evidence as internal-only reference
            </label>
            <Button
              variant="outline"
              onClick={() => createPreview.mutate()}
              disabled={!effectiveTargetParentId || createPreview.isPending}
            >
              {createPreview.isPending && <LoaderCircle className="animate-spin" />}
              Preview copy
            </Button>
            {preview && (
              <PreviewPanel
                title={`${preview.totals.nodes} records · ${preview.totals.costLines} cost lines · ${preview.totals.evidence} evidence files`}
                badges={[
                  `${preview.conflicts.length} conflicts`,
                  `${preview.totals.skippedCostLines} skipped costs`,
                ]}
                messages={[...preview.conflicts, ...preview.warnings]}
                destructive={preview.conflicts.length > 0}
              >
                <Button
                  onClick={() => commit.mutate()}
                  disabled={preview.conflicts.length > 0 || commit.isPending}
                >
                  {commit.isPending && <LoaderCircle className="animate-spin" />}
                  Commit copy
                </Button>
              </PreviewPanel>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  )
}

function PreviewPanel({
  title,
  badges,
  messages,
  destructive = false,
  children,
}: {
  title: string
  badges: string[]
  messages: string[]
  destructive?: boolean
  children: ReactNode
}) {
  return (
    <Alert variant={destructive ? "destructive" : "default"}>
      <Upload />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <div className="mt-1 flex flex-wrap gap-2">
          {badges.map((badge) => <Badge key={badge} variant="outline">{badge}</Badge>)}
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          {messages.map((message) => <li key={message}>{message}</li>)}
        </ul>
        <div className="mt-4">{children}</div>
      </AlertDescription>
    </Alert>
  )
}

function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function showError(error: Error): void {
  toast.error(error.message)
}
