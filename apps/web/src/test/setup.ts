import "@testing-library/jest-dom/vitest"

import { cleanup } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest"

import { server } from "@/test/server"
import { setViewport } from "@/test/viewport"

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})

beforeEach(() => {
  window.history.replaceState(null, "", "/")
  setViewport(1024)
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
})

afterAll(() => {
  server.close()
})

Object.defineProperty(window, "scrollTo", {
  configurable: true,
  writable: true,
  value: vi.fn(),
})

let animationFrameId = 0

Object.defineProperty(window, "requestAnimationFrame", {
  configurable: true,
  writable: true,
  value: vi.fn((callback: FrameRequestCallback) => {
    const id = ++animationFrameId
    callback(performance.now())
    return id
  }),
})

Object.defineProperty(window, "cancelAnimationFrame", {
  configurable: true,
  writable: true,
  value: vi.fn(),
})

Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  writable: true,
  value: vi.fn(),
})

Object.defineProperties(window.HTMLElement.prototype, {
  hasPointerCapture: {
    configurable: true,
    writable: true,
    value: vi.fn(() => false),
  },
  setPointerCapture: {
    configurable: true,
    writable: true,
    value: vi.fn(),
  },
  releasePointerCapture: {
    configurable: true,
    writable: true,
    value: vi.fn(),
  },
})
