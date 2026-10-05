import { z } from "zod";

export const nodeKindSchema = z.enum([
  "vehicle",
  "system",
  "assembly",
  "subassembly",
  "part",
]);

export const procurementTypeSchema = z.enum(["made", "bought", "unknown"]);

export const costKindSchema = z.enum([
  "material",
  "process",
  "fastener",
  "tooling",
]);

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  season: z.number().int().min(2020).max(2100),
  vehicleType: z.enum(["electric", "combustion", "dual"]),
  status: z.enum(["draft", "review", "submitted"]),
  rulePackVersion: z.string().min(1),
  catalogRevision: z.string().min(1),
  costModel: z.literal("competition-universal-dollar"),
});

export const costNodeSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  kind: nodeKindSchema,
  systemCode: z.string().min(2).max(3).nullable(),
  referenceId: z.string().nullable(),
  fullNumber: z.string().nullable(),
  name: z.string().min(1),
  description: z.string(),
  revision: z.string().nullable(),
  procurementType: procurementTypeSchema,
  quantity: z.string(),
  version: z.number().int().nonnegative(),
  sourceImportRow: z.number().int().positive().nullable(),
});

export const validationIssueSchema = z.object({
  id: z.string(),
  severity: z.enum(["blocker", "warning", "notice"]),
  code: z.string(),
  title: z.string(),
  detail: z.string(),
  nodeId: z.string().uuid().nullable(),
  ruleReference: z.string().nullable(),
});

export type Project = z.infer<typeof projectSchema>;
export type NodeKind = z.infer<typeof nodeKindSchema>;
export type CostNode = z.infer<typeof costNodeSchema>;
export type ValidationIssue = z.infer<typeof validationIssueSchema>;
