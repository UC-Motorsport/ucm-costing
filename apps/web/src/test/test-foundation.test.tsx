import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"

import { api } from "@/lib/api"
import { metaFixture } from "@/test/fixtures"
import {
  renderWithProviders,
  screen,
} from "@/test/render"

function MetadataProbe() {
  const [enabled, setEnabled] = useState(false)
  const metadata = useQuery({
    queryKey: ["test", "metadata"],
    queryFn: api.meta,
    enabled,
  })

  if (!enabled) {
    return (
      <button type="button" onClick={() => setEnabled(true)}>
        Load application metadata
      </button>
    )
  }
  if (metadata.isPending) {
    return <p role="status">Loading metadata</p>
  }
  if (metadata.isError) {
    return <p role="alert">{metadata.error.message}</p>
  }
  return (
    <output aria-label="Application name">
      {metadata.data.application}
    </output>
  )
}

describe("frontend test foundation", () => {
  it("renders React, drives a user interaction, and resolves the real API client through MSW", async () => {
    const { queryClient, user } = renderWithProviders(<MetadataProbe />)

    await user.click(
      screen.getByRole("button", {
        name: "Load application metadata",
      }),
    )

    expect(
      await screen.findByRole("status", {
        name: "Application name",
      }),
    ).toHaveTextContent(metaFixture.application)
    expect(queryClient.getQueryData(["test", "metadata"])).toEqual(
      metaFixture,
    )
  })
})
