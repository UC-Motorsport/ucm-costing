import { fireEvent } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { EvidencePreview } from "@/features/evidence/evidence-preview"
import type { Evidence } from "@/lib/api"
import { evidenceFixture } from "@/test/fixtures"
import { renderWithProviders, screen } from "@/test/render"

const photoFixture = {
  ...evidenceFixture,
  id: "evidence-upright-photo",
  kind: "image",
  display_name: "upright-photo.png",
  mime_type: "image/png",
  viewUrl: "/api/evidence/evidence-upright-photo/view",
  downloadUrl: "/api/evidence/evidence-upright-photo/download",
} satisfies Evidence

describe("EvidencePreview", () => {
  it("shows a PDF first-page image and keeps opening available if it fails", async () => {
    const item = {
      ...evidenceFixture,
      thumbnailUrl: "/api/evidence/drawing/thumbnail?v=1",
    }
    const { user } = renderWithProviders(
      <EvidencePreview item={item} variant="gallery" />,
    )
    const button = screen.getByRole("button", {
      name: `Preview ${item.display_name}`,
    })
    const thumbnail = button.querySelector("img")!
    expect(thumbnail).toHaveAttribute("src", item.thumbnailUrl)
    fireEvent.error(thumbnail)
    expect(
      screen.getByText("Preview unavailable · Click to open PDF"),
    ).toBeVisible()
    await user.click(button)
    expect(screen.getByTitle(`Preview ${item.display_name}`)).toHaveAttribute(
      "src",
      `${item.viewUrl}#toolbar=1&navpanes=0`,
    )
  })

  it.each([
    ["technical drawing", evidenceFixture],
    ["photo", photoFixture],
  ])("makes the %s downloadable from its preview", async (_, item) => {
    const { user } = renderWithProviders(<EvidencePreview item={item} />)

    await user.click(
      screen.getByRole("button", { name: `Preview ${item.display_name}` }),
    )

    const download = await screen.findByRole("link", {
      name: `Download ${item.display_name}`,
    })
    expect(download).toHaveAttribute("href", item.downloadUrl)
    expect(download).toHaveAttribute("download", item.display_name)
  })
})
