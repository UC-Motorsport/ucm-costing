import type {
  CostBreakdown,
  CostKind,
  NodeKind,
} from "@ucm/domain";
import type { QueryResultRow } from "pg";

import type { ProjectRow } from "./project-lifecycle-service";

export interface NodeRow extends QueryResultRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  kind: NodeKind;
  system_code: string | null;
  raw_hla: string | null;
  raw_subassembly: string | null;
  raw_part_number: string | null;
  reference_id: string | null;
  full_number: string | null;
  name: string;
  description: string;
  revision: string | null;
  procurement_type: "made" | "bought" | "unknown";
  drawing_required?: boolean;
  work_status?: "none" | "needs-attention" | "done";
  flag_comment?: string;
  image_required?: boolean;
  image_requirement_reason?: string;
  quantity: string;
  internal_note: string;
  source_import_batch_id: string | null;
  source_import_row: number | null;
  sort_order: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CostLineRow extends QueryResultRow {
  id: string;
  node_id: string;
  kind: CostKind;
  catalogue_item_id: string | null;
  stock_size_name?: string | null;
  catalogue_unit?: string | null;
  catalogue_unit_2?: string | null;
  catalogue_provenance?: "official" | "edited" | "team" | null;
  catalogue_revision?: number | null;
  catalogue_uses_unit_amount?: boolean | null;
  description: string;
  use_description: string;
  unit_cost: string;
  quantity: string;
  multiplier: string;
  multiplier_name: string | null;
  multiplier_catalogue_item_id: string | null;
  fraction_included: string;
  production_volume_factor: string | null;
  size_inputs_json: string;
  calculation_json: string;
  subtotal: string;
  sort_order: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectNode extends NodeRow {
  costLines: CostLineRow[];
  breakdown: CostBreakdown;
  children: ProjectNode[];
}

export interface ProjectDetail {
  project: Omit<ProjectRow, "focus_systems_json"> & {
    focusSystems: string[];
  };
  tree: ProjectNode;
  flatNodes: ProjectNode[];
  breakdown: CostBreakdown;
}
