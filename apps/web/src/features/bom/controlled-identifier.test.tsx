import { useState } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { ControlledIdentifier } from "@/features/bom/controlled-identifier"
import {
  composeControlledNumber,
  parseControlledNumber,
  referenceWithSide,
  findNumberConflict,
  isControlledNumberForContext,
  splitControlledReference,
  suggestControlledReference,
} from "@/features/bom/controlled-identifier-utils"
import { assemblyNodeFixture, partNodeFixture } from "@/test/fixtures"

describe("ControlledIdentifier", () => {
  it("renders the current season and six-digit controlled number as labeled segments", () => {
    render(
      <ControlledIdentifier
        entryNumber="E13"
        season={2026}
        systemCode="BR"
        fullNumber="E13-26-BR-030101-A"
        referenceId="030101"
        revision="A"
      />,
    )

    const breakdown = screen.getByRole("region", {
      name: "Controlled identifier breakdown",
    })

    for (const [label, value] of [
      ["ENTRY", "E13"],
      ["YEAR", "26"],
      ["SYSTEM", "BR"],
      ["ASSY", "03"],
      ["LVL", "01"],
      ["PART", "01"],
      ["REV", "A"],
    ]) {
      expect(
        within(breakdown).getByLabelText(`${label}: ${value}`),
      ).toBeInTheDocument()
    }
  })

  it("pads a legacy one-digit level to two digits", () => {
    expect(splitControlledReference("03101")).toEqual({
      assembly: "03",
      level: "01",
      part: "01",
    })
  })

  it("composes a normalized full number from the inherited context", () => {
    expect(
      composeControlledNumber({
        entryNumber: "e17",
        season: 2026,
        systemCode: "su",
        reference: "030103",
        revision: "a",
      }),
    ).toBe("E17-26-SU-030103-A")
  })

  it("edits the controlled number through its compact segments", async () => {
    const user = userEvent.setup()
    let nextFullNumber = ""

    render(
      <ControlledIdentifier
        entryNumber="E13"
        season={2026}
        systemCode="BR"
        fullNumber="E13-26-BR-030101-A"
        referenceId="030101"
        revision="A"
        onFullNumberChange={(value) => {
          nextFullNumber = value
        }}
        onRevisionChange={() => undefined}
      />,
    )

    const assembly = screen.getByLabelText("Assembly number segment")
    await user.click(assembly)
    await user.clear(assembly)
    await user.type(assembly, "12")

    expect(nextFullNumber).toBe("E13-26-BR-120101-A")
    expect(screen.queryByLabelText("Full number")).not.toBeInTheDocument()
  })

  it("applies a suggested part number to every reference input", async () => {
    const user = userEvent.setup()

    function SuggestedIdentifier() {
      const [fullNumber, setFullNumber] = useState("")

      return (
        <ControlledIdentifier
          entryNumber="E13"
          season={2026}
          systemCode="BR"
          fullNumber={fullNumber}
          referenceId=""
          revision="A"
          onFullNumberChange={setFullNumber}
          onRevisionChange={() => undefined}
          suggestedReference="030104"
          suggestionLabel="Suggested part number"
        />
      )
    }

    render(<SuggestedIdentifier />)

    expect(screen.getByText("E13-26-BR-030104-A")).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: "Use suggested number" }),
    )

    expect(screen.getByLabelText("Assembly number segment")).toHaveValue("03")
    expect(screen.getByLabelText("Level number segment")).toHaveValue("01")
    expect(screen.getByLabelText("Part number segment")).toHaveValue("04")
  })

  it("suggests the next unused sibling part reference", () => {
    const parent = {
      ...assemblyNodeFixture,
      full_number: "E17-26-SU-030000-A",
      reference_id: "030000",
      children: [],
    }
    const existingParts = ["01", "02"].map((part, index) => ({
      ...partNodeFixture,
      id: `existing-part-${part}`,
      parent_id: parent.id,
      full_number: `E17-26-SU-0301${part}-A`,
      reference_id: `0301${part}`,
      sort_order: index,
    }))
    const unnumberedPart = {
      ...partNodeFixture,
      id: "unnumbered-part",
      parent_id: parent.id,
      full_number: null,
      reference_id: null,
      sort_order: 2,
    }

    expect(
      suggestControlledReference(unnumberedPart, [
        parent,
        ...existingParts,
        unnumberedPart,
      ]),
    ).toBe("030103")
  })

  it("preserves the shared base reference of legacy left and right parts", () => {
    const parent = {
      ...assemblyNodeFixture,
      full_number: "E17-26-SU-030000-A",
      reference_id: "030000",
      children: [],
    }
    const leftPart = {
      ...partNodeFixture,
      id: "legacy-left-part",
      parent_id: parent.id,
      full_number: null,
      reference_id: "030101-L",
      sort_order: 0,
    }
    const rightPart = {
      ...partNodeFixture,
      id: "legacy-right-part",
      parent_id: parent.id,
      full_number: null,
      reference_id: "030101-R",
      sort_order: 1,
    }
    const nodes = [parent, leftPart, rightPart]

    expect(suggestControlledReference(leftPart, nodes)).toBe("030101")
    expect(suggestControlledReference(rightPart, nodes)).toBe("030101")
  })

  it("retains an assembly's valid six-digit reference", () => {
    const unnumberedAssembly = {
      ...assemblyNodeFixture,
      full_number: null,
      reference_id: "030000",
    }

    expect(
      suggestControlledReference(unnumberedAssembly, [unnumberedAssembly]),
    ).toBe("030000")
  })

  it("suggests the next sibling assembly reference", () => {
    const existingAssemblies = ["010000", "010100"].map((reference, index) => ({
      ...assemblyNodeFixture,
      id: `existing-assembly-${reference}`,
      full_number: `E17-26-SU-${reference}-A`,
      reference_id: reference,
      sort_order: index,
      children: [],
    }))
    const unnumberedAssembly = {
      ...assemblyNodeFixture,
      id: "unnumbered-assembly",
      full_number: null,
      reference_id: null,
      sort_order: 2,
      children: [],
    }

    expect(
      suggestControlledReference(unnumberedAssembly, [
        ...existingAssemblies,
        unnumberedAssembly,
      ]),
    ).toBe("010200")
  })

  it("suggests the next level for a subassembly", () => {
    const parent = {
      ...assemblyNodeFixture,
      id: "parent-assembly",
      full_number: "E17-26-SU-030000-A",
      reference_id: "030000",
      children: [],
    }
    const existingSubassembly = {
      ...assemblyNodeFixture,
      id: "existing-subassembly",
      parent_id: parent.id,
      kind: "subassembly" as const,
      full_number: "E17-26-SU-030100-A",
      reference_id: "030100",
      sort_order: 0,
      children: [],
    }
    const unnumberedSubassembly = {
      ...existingSubassembly,
      id: "unnumbered-subassembly",
      full_number: null,
      reference_id: null,
      sort_order: 1,
    }

    expect(
      suggestControlledReference(unnumberedSubassembly, [
        parent,
        existingSubassembly,
        unnumberedSubassembly,
      ]),
    ).toBe("030200")
  })

  it("recognises a controlled number only in the current record context", () => {
    const context = {
      entryNumber: "E13",
      season: 2026,
      systemCode: "BR",
    }

    expect(isControlledNumberForContext("E13-26-BR-030101-A", context)).toBe(
      true,
    )
    expect(isControlledNumberForContext("E13-26-SU-030101-A", context)).toBe(
      false,
    )
  })
  it("round-trips side and revision, including revision edits in progress", () => {
    for (const side of ["", "L", "R"] as const) {
      for (const revision of ["A", "B", ""]) {
        const full = composeControlledNumber({
          entryNumber: "E13",
          season: 2026,
          systemCode: "AD",
          reference: "010001",
          side,
          revision,
        })
        expect(parseControlledNumber(full)).toMatchObject({
          reference: "010001",
          side,
          revision,
        })
      }
    }
    expect(parseControlledNumber("E13-26-AD-010001-L")).toMatchObject({
      side: "",
      revision: "L",
    })
    expect(parseControlledNumber("e13–26–ad–010001–r–b")).toMatchObject({
      side: "R",
      revision: "B",
    })
  })

  it("changes side without renumbering and preserves it through number and revision edits", async () => {
    const user = userEvent.setup()
    function Editor() {
      const [fullNumber, setFullNumber] = useState("E13-26-AD-010001-A")
      const parsed = parseControlledNumber(fullNumber)!
      return (
        <>
          <ControlledIdentifier
            entryNumber="E13"
            season={2026}
            systemCode="AD"
            fullNumber={fullNumber}
            referenceId={referenceWithSide(parsed.reference, parsed.side)}
            revision={parsed.revision}
            onFullNumberChange={setFullNumber}
            onRevisionChange={() => {}}
            showSide
          />
          <output>{fullNumber}</output>
        </>
      )
    }
    render(<Editor />)
    await user.click(screen.getByRole("button", { name: "Left" }))
    expect(screen.getByRole("status")).toHaveTextContent("E13-26-AD-010001-L-A")
    await user.clear(screen.getByLabelText("Part number segment"))
    await user.type(screen.getByLabelText("Part number segment"), "02")
    await user.clear(screen.getByLabelText("Revision segment"))
    await user.type(screen.getByLabelText("Revision segment"), "B")
    expect(screen.getByRole("status")).toHaveTextContent("E13-26-AD-010002-L-B")
    await user.click(screen.getByRole("button", { name: "Right" }))
    expect(screen.getByRole("status")).toHaveTextContent("E13-26-AD-010002-R-B")
    await user.click(screen.getByRole("button", { name: "None" }))
    expect(screen.getByRole("status")).toHaveTextContent("E13-26-AD-010002-B")
  })

  it("allows counterparts but finds duplicate full identities case-insensitively", () => {
    const left = { ...partNodeFixture, full_number: "E13-26-AD-010001-L-A" }
    expect(findNumberConflict("e13-26-ad-010001-l-a", [left])).toBe(left)
    expect(findNumberConflict("E13-26-AD-010001-R-A", [left])).toBeUndefined()
    expect(
      findNumberConflict(left.full_number, [left], left.id),
    ).toBeUndefined()
  })

  it("shows side without editable buttons for read-only records", () => {
    render(
      <ControlledIdentifier
        entryNumber="E13"
        season={2026}
        systemCode="AD"
        fullNumber="E13-26-AD-010001-L-A"
        referenceId="010001-L"
        revision="A"
        showSide
      />,
    )
    expect(screen.getByText("Left")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
  it("retains handedness when a legacy reference field contains the full identifier", () => {
    const importedRight = {
      ...partNodeFixture,
      full_number: null,
      reference_id: "E17-26-SU-030101-R-A",
    }
    expect(suggestControlledReference(importedRight, [importedRight])).toBe(
      "030101",
    )
    render(
      <ControlledIdentifier
        entryNumber="E17"
        season={2026}
        systemCode="SU"
        fullNumber=""
        referenceId={importedRight.reference_id}
        revision="A"
        showSide
      />,
    )
    expect(screen.getByText("Right")).toBeInTheDocument()
    expect(screen.getByLabelText("PART: 01")).toBeInTheDocument()
  })
})
