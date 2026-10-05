import { calculateCostLine, type CostLineInput } from "@ucm/domain";

import {
  LOCAL_ADDENDUM_SHA256,
  LOCAL_ADDENDUM_VERSION,
} from "../config";
import type {
  DatabaseHandle,
  TransactionHandle,
} from "../db/database";
import { systemDefinitions } from "../domain/systems";
import {
  CATALOGUE_RELEASE_ID,
  installReferenceData,
  OFFICIAL_RULE_DOCUMENT_ID,
  stableSeedUuid,
} from "./reference-data-service";

export const DEMO_PROJECT_ID = stableSeedUuid(
  "project:uc-motorsport:2026",
);

const DEMO_PROJECT_SUMMARY = [
  "This report uses a synthetic demonstration vehicle to exercise the UCM costing workflow. It is not the UCM26 design and none of its components, quantities, manufacturing choices, or costs may be submitted as team data. This MVP seed is deliberately incomplete and must not be submitted.",
  "The demonstration concept balances reliability, performance, serviceability, and catalogue cost. Its front cooling assembly uses a bought radiator and fan with a simple fabricated bracket. The bought components carry higher material cost but reduce manufacturing complexity, while the bracket demonstrates how a small made part combines material, process, fastener, and shared-tooling costs.",
  "The braking, chassis, aerodynamic, electrical, steering, suspension, miscellaneous, and wheel fixtures are deliberately compact examples rather than claims about the competition vehicle. Each was selected to exercise a different mixture of the four cost buckets and to make system-level proportions visible. The fictional choices favour straightforward, inspectable manufacturing routes and ordinary service access over highly integrated components.",
  "Reliability is represented by conventional fasteners, replaceable modules, and conservative process examples. Performance trade-offs are represented by the higher process content of the suspension and aerodynamic fixtures. These values exist only to demonstrate roll-ups, page references, drawing placement, and report reconciliation from one immutable calculation graph.",
  "The fictional architecture also demonstrates design-for-manufacture decisions. Parts use deliberately ordinary sheet, billet, bought-component, and fastening examples so reviewers can see where material geometry, process repetition, production-volume allocation, and on-car quantity enter the calculation. The examples are intentionally generic and are not derived from last season's vehicle, drawings, manufacturing plans, or supplier quotes.",
  "Service access is represented through removable covers, locating features, modular brackets, and replaceable interfaces. In a real submission those decisions would be supported by current CAD drawings, manufacturing evidence, and the official catalogue revision selected for the event. Here they exist only to make the generated hierarchy diagrams, assembly roll-ups, cost-table continuations, and drawing adjacency realistic enough to test.",
  "Every displayed total is generated from the same persisted calculation graph used by the web interface. The master bill of materials reports direct line cost, while assembly sheets separately show rolled-up child cost so neither value is counted twice. Page references are assigned after pagination, and export is blocked when required project declarations, evidence, or catalogue provenance remain incomplete.",
  "Production-equivalent methods are used in this fixture only to illustrate report structure. A real project must document why a bulk-production method preserves design intent and process capability, attach the required drawings and datasheets, and replace every synthetic record with a pinned catalogue selection. The demonstration therefore remains visibly draft data even when every rendered total reconciles.",
].join("\n\n");

/**
 * Explicit non-production fixture for local demonstrations and automated
 * tests. Production startup must never call this.
 */
export async function seedDemoProject(
  database: DatabaseHandle,
): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("demo-seed-disabled-in-production");
  }
  if (
    process.env.NODE_ENV !== "test" &&
    process.env.UCM_ENABLE_DEMO_SEED !== "true"
  ) {
    throw new Error("demo-seed-requires-UCM_ENABLE_DEMO_SEED");
  }

  await installReferenceData(database);
  const now = new Date().toISOString();
  const buffer: DemoSeedBuffer = { nodes: [], costLines: [] };
  seedDemoTree(buffer, now);
  await database.transaction(async (transaction) => {
    await transaction.query(
      `
        INSERT INTO projects(
          id, name, season, vehicle_type, entry_number, status,
          rule_pack_version, rule_pack_sha256, rule_source_document_id,
          catalogue_release_id, cost_model, project_summary,
          numbering_convention, bulk_method_summary, focus_systems_json,
          created_at, updated_at, version
        )
        VALUES (
          $1, $2, 2026, 'electric', 'E13', 'draft',
          $3, $4, $5, $6, 'competition-universal-dollar', $7, $8, $9,
          '["DR"]'::jsonb, $10, $10, 0
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        DEMO_PROJECT_ID,
        "UC Motorsport 2026 synthetic demonstration",
        LOCAL_ADDENDUM_VERSION,
        LOCAL_ADDENDUM_SHA256,
        OFFICIAL_RULE_DOCUMENT_ID,
        CATALOGUE_RELEASE_ID,
        DEMO_PROJECT_SUMMARY,
        "Full identifiers follow entry-year-system-reference-revision. The six-character reference segment is derived from the team assembly allocation and retained exactly across the BOM, tables, drawings, and evidence.",
        "Production-equivalent methods are used only when documented evidence shows equivalent design intent and process capability; otherwise the actual prototype method is costed.",
        now,
      ],
    );
    await insertDemoNodes(transaction, buffer.nodes);
    await insertDemoCostLines(transaction, buffer.costLines);
  });
}

function seedDemoTree(database: DemoSeedBuffer, now: string): void {
  const vehicleId = stableSeedUuid("node:ucm26:vehicle");
  insertNode(database, {
    id: vehicleId,
    projectId: DEMO_PROJECT_ID,
    parentId: null,
    kind: "vehicle",
    systemCode: null,
    rawHla: null,
    rawSubassembly: null,
    rawPartNumber: null,
    referenceId: "UCM26",
    fullNumber: "E13-26-UCM-000000-A",
    name: "UCM 2026 Electric Vehicle",
    description: "Formula SAE-Australasia 2026 competition vehicle",
    revision: "A",
    procurementType: "made",
    quantity: "1",
    sortOrder: 0,
    now,
  });

  const systemIds = new Map<string, string>();
  systemDefinitions.forEach((system, index) => {
    const systemId = stableSeedUuid(`node:ucm26:system:${system.code}`);
    systemIds.set(system.code, systemId);
    insertNode(database, {
      id: systemId,
      projectId: DEMO_PROJECT_ID,
      parentId: vehicleId,
      kind: "system",
      systemCode: system.code,
      rawHla: null,
      rawSubassembly: null,
      rawPartNumber: null,
      referenceId: system.code,
      fullNumber: `E13-26-${system.code}-000000-A`,
      name: system.name,
      description: `${system.name} system`,
      revision: "A",
      procurementType: "made",
      quantity: "1",
      sortOrder: index,
      now,
    });
  });

  const drivetrainId = systemIds.get("DR");
  if (!drivetrainId) {
    throw new Error("DR system seed missing");
  }
  const assemblyId = stableSeedUuid("node:ucm26:dr:01");
  insertNode(database, {
    id: assemblyId,
    projectId: DEMO_PROJECT_ID,
    parentId: drivetrainId,
    kind: "assembly",
    systemCode: "DR",
    rawHla: "01",
    rawSubassembly: "00",
    rawPartNumber: "00",
    referenceId: "010000",
    fullNumber: "E13-26-DR-010000-A",
    name: "Front motor cooling",
    description: "Front motor and inverter cooling assembly",
    revision: "A",
    procurementType: "made",
    quantity: "1",
    sortOrder: 0,
    now,
  });

  const radiatorId = stableSeedUuid("node:ucm26:dr:010101");
  const fanId = stableSeedUuid("node:ucm26:dr:010102");
  const bracketId = stableSeedUuid("node:ucm26:dr:010103");
  insertNode(database, {
    id: radiatorId,
    projectId: DEMO_PROJECT_ID,
    parentId: assemblyId,
    kind: "part",
    systemCode: "DR",
    rawHla: "01",
    rawSubassembly: "01",
    rawPartNumber: "01",
    referenceId: "010101",
    fullNumber: "E13-26-DR-010101-A",
    name: "Radiator core",
    description: "Bought aluminium radiator core",
    revision: "A",
    procurementType: "bought",
    quantity: "1",
    sortOrder: 0,
    now,
  });
  insertNode(database, {
    id: fanId,
    projectId: DEMO_PROJECT_ID,
    parentId: assemblyId,
    kind: "part",
    systemCode: "DR",
    rawHla: "01",
    rawSubassembly: "01",
    rawPartNumber: "02",
    referenceId: "010102",
    fullNumber: "E13-26-DR-010102-A",
    name: "Cooling fan",
    description: "Bought 12 V cooling fan",
    revision: "A",
    procurementType: "bought",
    quantity: "1",
    sortOrder: 1,
    now,
  });
  insertNode(database, {
    id: bracketId,
    projectId: DEMO_PROJECT_ID,
    parentId: assemblyId,
    kind: "part",
    systemCode: "DR",
    rawHla: "01",
    rawSubassembly: "01",
    rawPartNumber: "03",
    referenceId: "010103",
    fullNumber: "E13-26-DR-010103-A",
    name: "Radiator mounting bracket",
    description: "Laser-cut and bent aluminium radiator top mount",
    revision: "A",
    procurementType: "made",
    quantity: "2",
    sortOrder: 2,
    now,
  });

  insertCostLine(database, radiatorId, "radiator-material", {
    kind: "material",
    unitCost: "1102.30",
    quantity: "1",
  }, "Radiator core", "Bought component", now);
  insertCostLine(database, radiatorId, "radiator-process", {
    kind: "process",
    unitCost: "221.40",
    quantity: "1",
  }, "Supplier manufacturing allowance", "Catalogue process", now);
  insertCostLine(database, radiatorId, "radiator-fastener", {
    kind: "fastener",
    unitCost: "18.60",
    quantity: "1",
  }, "Integrated fittings", "Radiator fittings", now);
  insertCostLine(database, radiatorId, "radiator-tooling", {
    kind: "tooling",
    unitCost: "259200",
    quantity: "1",
    productionVolumeFactor: "3000",
  }, "Radiator production tooling", "Bought item tooling allocation", now);

  insertCostLine(database, fanId, "fan-material", {
    kind: "material",
    unitCost: "624.80",
    quantity: "1",
  }, "Cooling fan", "Bought component", now);

  insertCostLine(database, bracketId, "bracket-material", {
    kind: "material",
    unitCost: "8.42",
    quantity: "0.12",
  }, "Aluminium 6061-T6 sheet", "Bracket blank", now);
  insertCostLine(database, bracketId, "bracket-laser", {
    kind: "process",
    unitCost: "3.84",
    quantity: "1",
  }, "Laser cutting", "Cut bracket blank", now);
  insertCostLine(database, bracketId, "bracket-bend", {
    kind: "process",
    unitCost: "2.10",
    quantity: "1",
  }, "Bending – press brake", "Two bends", now);
  insertCostLine(database, bracketId, "bracket-fasteners", {
    kind: "fastener",
    unitCost: "0.32",
    quantity: "4",
  }, "M6 × 16 socket head cap screw", "Bracket installation", now);
  insertCostLine(database, bracketId, "bracket-tooling", {
    kind: "tooling",
    unitCost: "16500",
    quantity: "0.125",
    fractionIncluded: "1",
    productionVolumeFactor: "3000",
  }, "Bending fixture", "Locate and clamp bracket", now);

  insertCostLine(database, assemblyId, "dr-assembly-process", {
    kind: "process",
    unitCost: "1.50",
    quantity: "8",
  }, "Cooling assembly operation", "Join radiator, fan, and mounting bracket", now);
  insertCostLine(database, assemblyId, "dr-assembly-fastener", {
    kind: "fastener",
    unitCost: "0.40",
    quantity: "12",
  }, "M6 assembly fastener", "Secure cooling module", now);
  insertCostLine(database, assemblyId, "dr-assembly-tooling", {
    kind: "tooling",
    unitCost: "6000",
    quantity: "1",
    productionVolumeFactor: "3000",
  }, "Cooling module inspection fixture", "Synthetic assembly fixture", now);
  seedDemoAssemblyRows(
    database,
    assemblyId,
    "DR",
    "Front motor cooling",
    now,
  );

  const compactFixtures: DemoSystemFixture[] = [
    {
      code: "BR",
      hla: "03",
      assemblyName: "Demo brake corner",
      assemblyDescription: "Synthetic brake-corner assembly",
      partName: "Pedal backing plate",
      partDescription: "Fictional laser-cut brake backing plate",
      quantity: "2",
      material: "42.50",
      process: "18.60",
      fastener: "3.20",
      toolingUnitCost: "7200",
      assemblyProcess: "6.40",
      assemblyFastener: "1.80",
    },
    {
      code: "CH",
      hla: "08",
      assemblyName: "Demo front bulkhead",
      assemblyDescription: "Synthetic front bulkhead assembly",
      partName: "Bulkhead shear panel",
      partDescription: "Fictional folded aluminium shear panel",
      quantity: "1",
      material: "78.40",
      process: "94.20",
      fastener: "6.40",
      toolingUnitCost: "33000",
      assemblyProcess: "8.00",
      assemblyFastener: "2.40",
    },
    {
      code: "AD",
      hla: "11",
      assemblyName: "Demo front wing",
      assemblyDescription: "Synthetic front-wing assembly",
      partName: "Mainplane shell",
      partDescription: "Fictional composite mainplane shell",
      quantity: "1",
      material: "135.00",
      process: "210.00",
      fastener: "4.60",
      toolingUnitCost: "60000",
      assemblyProcess: "9.50",
      assemblyFastener: "3.10",
    },
    {
      code: "EL",
      hla: "09",
      assemblyName: "Demo low-voltage controls",
      assemblyDescription: "Synthetic low-voltage control module",
      partName: "Controller enclosure",
      partDescription: "Fictional sealed controller enclosure",
      quantity: "1",
      material: "95.00",
      process: "28.00",
      fastener: "3.60",
      toolingUnitCost: "9000",
      assemblyProcess: "7.00",
      assemblyFastener: "2.00",
    },
    {
      code: "MS",
      hla: "17",
      assemblyName: "Demo driver fit",
      assemblyDescription: "Synthetic driver-fit assembly",
      partName: "Seat insert",
      partDescription: "Fictional moulded seat insert",
      quantity: "1",
      material: "62.00",
      process: "38.00",
      fastener: "1.80",
      toolingUnitCost: "15000",
      assemblyProcess: "5.00",
      assemblyFastener: "1.00",
    },
    {
      code: "ST",
      hla: "04",
      assemblyName: "Demo steering rack",
      assemblyDescription: "Synthetic steering-rack assembly",
      partName: "Rack housing",
      partDescription: "Fictional machined steering-rack housing",
      quantity: "1",
      material: "70.00",
      process: "120.00",
      fastener: "5.20",
      toolingUnitCost: "18000",
      assemblyProcess: "10.00",
      assemblyFastener: "2.50",
    },
    {
      code: "SU",
      hla: "02",
      assemblyName: "Demo front upright",
      assemblyDescription: "Synthetic front-upright assembly",
      partName: "Upright body",
      partDescription: "Fictional machined aluminium upright",
      quantity: "2",
      material: "180.00",
      process: "360.00",
      fastener: "9.00",
      toolingUnitCost: "48000",
      assemblyProcess: "12.00",
      assemblyFastener: "4.00",
    },
    {
      code: "WT",
      hla: "07",
      assemblyName: "Demo wheel assembly",
      assemblyDescription: "Synthetic wheel assembly",
      partName: "Wheel centre",
      partDescription: "Fictional machined wheel centre",
      quantity: "4",
      material: "110.00",
      process: "190.00",
      fastener: "6.00",
      toolingUnitCost: "12000",
      assemblyProcess: "8.00",
      assemblyFastener: "3.00",
    },
  ];
  compactFixtures.forEach((fixture) => {
    const systemId = systemIds.get(fixture.code);
    if (!systemId) {
      throw new Error(`${fixture.code} system seed missing`);
    }
    seedDemoSystemFixture(
      database,
      systemId,
      fixture,
      now,
    );
  });
}

interface DemoSystemFixture {
  code: string;
  hla: string;
  assemblyName: string;
  assemblyDescription: string;
  partName: string;
  partDescription: string;
  quantity: string;
  material: string;
  process: string;
  fastener: string;
  toolingUnitCost: string;
  assemblyProcess: string;
  assemblyFastener: string;
}

function seedDemoSystemFixture(
  database: DemoSeedBuffer,
  systemId: string,
  fixture: DemoSystemFixture,
  now: string,
): void {
  const assemblyReference = `${fixture.hla}0000`;
  const partReference = `${fixture.hla}0101`;
  const assemblyId = stableSeedUuid(
    `node:ucm26:${fixture.code}:${assemblyReference}`,
  );
  const partId = stableSeedUuid(
    `node:ucm26:${fixture.code}:${partReference}`,
  );
  insertNode(database, {
    id: assemblyId,
    projectId: DEMO_PROJECT_ID,
    parentId: systemId,
    kind: "assembly",
    systemCode: fixture.code,
    rawHla: fixture.hla,
    rawSubassembly: "00",
    rawPartNumber: "00",
    referenceId: assemblyReference,
    fullNumber: `E13-26-${fixture.code}-${assemblyReference}-A`,
    name: fixture.assemblyName,
    description: fixture.assemblyDescription,
    revision: "A",
    procurementType: "made",
    quantity: "1",
    sortOrder: 0,
    now,
  });
  insertNode(database, {
    id: partId,
    projectId: DEMO_PROJECT_ID,
    parentId: assemblyId,
    kind: "part",
    systemCode: fixture.code,
    rawHla: fixture.hla,
    rawSubassembly: "01",
    rawPartNumber: "01",
    referenceId: partReference,
    fullNumber: `E13-26-${fixture.code}-${partReference}-A`,
    name: fixture.partName,
    description: fixture.partDescription,
    revision: "A",
    procurementType: "made",
    quantity: fixture.quantity,
    sortOrder: 0,
    now,
  });

  insertCostLine(database, assemblyId, `${fixture.code}-assembly-process`, {
    kind: "process",
    unitCost: fixture.assemblyProcess,
    quantity: "1",
  }, "Final assembly operation", `Assemble ${fixture.assemblyName}`, now);
  insertCostLine(database, assemblyId, `${fixture.code}-assembly-fastener`, {
    kind: "fastener",
    unitCost: fixture.assemblyFastener,
    quantity: "1",
  }, "Assembly fastener set", `Secure ${fixture.assemblyName}`, now);
  seedDemoAssemblyRows(
    database,
    assemblyId,
    fixture.code,
    fixture.assemblyName,
    now,
  );
  insertCostLine(database, partId, `${fixture.code}-part-material`, {
    kind: "material",
    unitCost: fixture.material,
    quantity: "1",
  }, "Synthetic catalogue material", fixture.partName, now);
  insertCostLine(database, partId, `${fixture.code}-part-process`, {
    kind: "process",
    unitCost: fixture.process,
    quantity: "1",
  }, "Synthetic manufacturing route", fixture.partDescription, now);
  insertCostLine(database, partId, `${fixture.code}-part-fastener`, {
    kind: "fastener",
    unitCost: fixture.fastener,
    quantity: "1",
  }, "Synthetic fastener allowance", `Install ${fixture.partName}`, now);
  insertCostLine(database, partId, `${fixture.code}-part-tooling`, {
    kind: "tooling",
    unitCost: fixture.toolingUnitCost,
    quantity: "1",
    productionVolumeFactor: "3000",
  }, "Synthetic production fixture", `Tooling for ${fixture.partName}`, now);

  const additionalParts = [
    {
      suffix: "02",
      name: `Demo ${fixture.code} interface bracket`,
      description: `Fictional serviceable interface bracket for ${fixture.assemblyName}`,
      quantity: "2",
      factor: 0.18,
    },
    {
      suffix: "03",
      name: `Demo ${fixture.code} locating spacer`,
      description: `Fictional locating spacer for ${fixture.assemblyName}`,
      quantity: "4",
      factor: 0.11,
    },
    {
      suffix: "04",
      name: `Demo ${fixture.code} inspection cover`,
      description: `Fictional removable inspection cover for ${fixture.assemblyName}`,
      quantity: "1",
      factor: 0.24,
    },
  ];
  additionalParts.forEach((part, index) => {
    const reference = `${fixture.hla}01${part.suffix}`;
    const extraPartId = stableSeedUuid(
      `node:ucm26:${fixture.code}:${reference}`,
    );
    insertNode(database, {
      id: extraPartId,
      projectId: DEMO_PROJECT_ID,
      parentId: assemblyId,
      kind: "part",
      systemCode: fixture.code,
      rawHla: fixture.hla,
      rawSubassembly: "01",
      rawPartNumber: part.suffix,
      referenceId: reference,
      fullNumber: `E13-26-${fixture.code}-${reference}-A`,
      name: part.name,
      description: part.description,
      revision: "A",
      procurementType: "made",
      quantity: part.quantity,
      sortOrder: index + 1,
      now,
    });
    insertCostLine(database, extraPartId, `${fixture.code}-part-${part.suffix}-material`, {
      kind: "material",
      unitCost: scaledDemoCost(fixture.material, part.factor),
      quantity: "1",
    }, "Synthetic catalogue material", part.name, now);
    insertCostLine(database, extraPartId, `${fixture.code}-part-${part.suffix}-process`, {
      kind: "process",
      unitCost: scaledDemoCost(fixture.process, part.factor + 0.07),
      quantity: "1",
    }, "Synthetic manufacturing route", part.description, now);
    insertCostLine(database, extraPartId, `${fixture.code}-part-${part.suffix}-fastener`, {
      kind: "fastener",
      unitCost: scaledDemoCost(fixture.fastener, part.factor + 0.12),
      quantity: "1",
    }, "Synthetic fastener allowance", `Install ${part.name}`, now);
    insertCostLine(database, extraPartId, `${fixture.code}-part-${part.suffix}-tooling`, {
      kind: "tooling",
      unitCost: scaledDemoCost(
        fixture.toolingUnitCost,
        part.factor + 0.16,
      ),
      quantity: "1",
      productionVolumeFactor: "3000",
    }, "Synthetic production fixture", `Tooling for ${part.name}`, now);
  });
}

function scaledDemoCost(
  value: string,
  factor: number,
): string {
  return (Number(value) * factor).toFixed(2);
}

function seedDemoAssemblyRows(
  database: DemoSeedBuffer,
  assemblyId: string,
  identityPrefix: string,
  assemblyName: string,
  now: string,
): void {
  const processSteps = [
    "Place assembly in demo fixture",
    "Verify synthetic datum",
    "Install temporary locator",
    "Align service interface",
    "Mark inspection point",
    "Deburr demonstration edge",
    "Clean joining surfaces",
    "Apply mock assembly aid",
    "Fit removable cover",
    "Check nominal clearance",
    "Seat locating feature",
    "Secure temporary clamp",
    "Verify hand access",
    "Perform visual inspection",
    "Record demo dimension",
    "Release temporary clamp",
    "Remove fixture locator",
    "Final synthetic inspection",
    "Transfer demo assembly",
  ];
  processSteps.forEach((description, index) => {
    insertCostLine(database, assemblyId, `${identityPrefix}-assembly-demo-process-${String(index + 1).padStart(2, "0")}`, {
      kind: "process",
      unitCost: (0.08 + index * 0.015).toFixed(3),
      quantity: "1",
    }, description, `Synthetic workflow step for ${assemblyName}`, now);
  });

  for (let index = 0; index < 7; index += 1) {
    insertCostLine(database, assemblyId, `${identityPrefix}-assembly-demo-fastener-${String(index + 1).padStart(2, "0")}`, {
      kind: "fastener",
      unitCost: (0.06 + index * 0.02).toFixed(2),
      quantity: "1",
    }, `Synthetic fastener allowance ${index + 1}`, `Demo joint for ${assemblyName}`, now);
  }
}

interface NodeSeed {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: string;
  systemCode: string | null;
  rawHla: string | null;
  rawSubassembly: string | null;
  rawPartNumber: string | null;
  referenceId: string | null;
  fullNumber: string | null;
  name: string;
  description: string;
  revision: string | null;
  procurementType: string;
  quantity: string;
  sortOrder: number;
  now: string;
}

interface CostLineSeed {
  id: string;
  nodeId: string;
  kind: CostLineInput["kind"];
  description: string;
  useDescription: string;
  unitCost: string;
  quantity: string;
  multiplier: string;
  fractionIncluded: string;
  productionVolumeFactor: string | null;
  calculationJson: string;
  subtotal: string;
  now: string;
}

interface DemoSeedBuffer {
  nodes: NodeSeed[];
  costLines: CostLineSeed[];
}

function insertNode(database: DemoSeedBuffer, node: NodeSeed): void {
  database.nodes.push(node);
}

function insertCostLine(
  database: DemoSeedBuffer,
  nodeId: string,
  identity: string,
  input: CostLineInput,
  description: string,
  useDescription: string,
  now: string,
): void {
  const calculated = calculateCostLine(input);
  database.costLines.push({
    id: stableSeedUuid(`line:ucm26:${identity}`),
    nodeId,
    kind: calculated.kind,
    description,
    useDescription,
    unitCost: calculated.unitCost,
    quantity: calculated.quantity,
    multiplier: calculated.multiplier,
    fractionIncluded: calculated.fractionIncluded,
    productionVolumeFactor: calculated.productionVolumeFactor ?? null,
    calculationJson: JSON.stringify(calculated),
    subtotal: calculated.subtotal,
    now,
  });
}

async function insertDemoNodes(
  transaction: TransactionHandle,
  nodes: readonly NodeSeed[],
): Promise<void> {
  if (nodes.length === 0) {
    return;
  }
  const values: unknown[] = [];
  const tuples = nodes.map((node, rowIndex) => {
    const start = rowIndex * 18;
    values.push(
      node.id,
      node.projectId,
      node.parentId,
      node.kind,
      node.systemCode,
      node.rawHla,
      node.rawSubassembly,
      node.rawPartNumber,
      node.referenceId,
      node.fullNumber,
      node.name,
      node.description,
      node.revision,
      node.procurementType,
      node.quantity,
      node.sortOrder,
      node.now,
      node.now,
    );
    return `(
      $${start + 1}, $${start + 2}, $${start + 3}, $${start + 4},
      $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8},
      $${start + 9}, $${start + 10}, $${start + 11}, $${start + 12},
      $${start + 13}, $${start + 14}, $${start + 15}, '', NULL, NULL,
      $${start + 16}, 0, $${start + 17}, $${start + 18}
    )`;
  });
  await transaction.query(
    `
      INSERT INTO cost_nodes(
        id, project_id, parent_id, kind, system_code, raw_hla,
        raw_subassembly, raw_part_number, reference_id, full_number,
        name, description, revision, procurement_type, quantity,
        internal_note, source_import_batch_id, source_import_row,
        sort_order, version, created_at, updated_at
      )
      VALUES ${tuples.join(",")}
      ON CONFLICT (id) DO NOTHING
    `,
    values,
  );
}

async function insertDemoCostLines(
  transaction: TransactionHandle,
  lines: readonly CostLineSeed[],
): Promise<void> {
  const batchSize = 250;
  for (let offset = 0; offset < lines.length; offset += batchSize) {
    const batch = lines.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((line, rowIndex) => {
      const start = rowIndex * 13;
      values.push(
        line.id,
        line.nodeId,
        line.kind,
        line.description,
        line.useDescription,
        line.unitCost,
        line.quantity,
        line.multiplier,
        line.fractionIncluded,
        line.productionVolumeFactor,
        line.calculationJson,
        line.subtotal,
        line.now,
      );
      return `(
        $${start + 1}, $${start + 2}, $${start + 3}, NULL,
        $${start + 4}, $${start + 5}, $${start + 6}, $${start + 7},
        $${start + 8}, NULL, NULL, $${start + 9}, $${start + 10},
        '{}'::jsonb, $${start + 11}::jsonb, $${start + 12},
        0, 0, $${start + 13}, $${start + 13}
      )`;
    });
    await transaction.query(
      `
        INSERT INTO cost_lines(
          id, node_id, kind, catalogue_item_id, description, use_description,
          unit_cost, quantity, multiplier, multiplier_name,
          multiplier_catalogue_item_id, fraction_included,
          production_volume_factor, size_inputs_json, calculation_json,
          subtotal, sort_order, version, created_at, updated_at
        )
        VALUES ${tuples.join(",")}
        ON CONFLICT (id) DO NOTHING
      `,
      values,
    );
  }
}
