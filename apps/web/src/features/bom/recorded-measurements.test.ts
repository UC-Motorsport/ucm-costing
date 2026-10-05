import { describe, expect, it } from "vitest"
import { recordedMeasurements } from "./recorded-measurements"

describe("recorded measurements", () => {
  it("labels stored mass and area without using a replacement catalogue's units", () => {
    expect(recordedMeasurements({ size1: "0.2576", size1Unit: "kg", size2: "0.744", size2Unit: "m^2" })).toEqual([
      { key: "size1", label: "Mass", value: "0.2576", unit: "kg" },
      { key: "size2", label: "Area", value: "0.744", unit: "m^2" },
    ])
  })
  it("retains zero and unknown-unit measurements without inventing units", () => {
    expect(recordedMeasurements({ size1: 0, size2: "3", size2Unit: "custom" })).toEqual([
      { key: "size1", label: "Size 1", value: "0", unit: "" },
      { key: "size2", label: "Size 2", value: "3", unit: "custom" },
    ])
  })
  it("ignores empty measurements and non-measurement metadata", () => {
    expect(recordedMeasurements({ size1: " ", size2: null, stockSizeCatalogueItemId: "id" })).toEqual([])
  })
})
