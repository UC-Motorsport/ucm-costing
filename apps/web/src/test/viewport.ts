import { vi } from "vitest"

type MediaListener = EventListenerOrEventListenerObject

interface MediaQueryState {
  query: string
  listeners: Set<MediaListener>
  legacyListeners: Set<(event: MediaQueryListEvent) => void>
  list: MediaQueryList
  lastMatch: boolean
}

export interface ViewportController {
  resize: (width: number) => void
}

function matchesWidth(query: string, width: number): boolean {
  const minWidth = query.match(/\(min-width:\s*(\d+)px\)/)
  const maxWidth = query.match(/\(max-width:\s*(\d+)px\)/)
  if (minWidth && width < Number(minWidth[1])) return false
  if (maxWidth && width > Number(maxWidth[1])) return false
  return true
}

export function setViewport(initialWidth: number): ViewportController {
  let width = initialWidth
  const states: MediaQueryState[] = []

  const updateInnerWidth = (nextWidth: number) => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: nextWidth,
    })
  }

  updateInnerWidth(width)

  const matchMedia = vi.fn((query: string): MediaQueryList => {
    const listeners = new Set<MediaListener>()
    const legacyListeners = new Set<
      (event: MediaQueryListEvent) => void
    >()
    const state = {} as MediaQueryState
    const list = {
      get matches() {
        return matchesWidth(query, width)
      },
      media: query,
      onchange: null,
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        legacyListeners.add(listener)
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        legacyListeners.delete(listener)
      },
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (type === "change") listeners.add(listener)
      },
      removeEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (type === "change") listeners.delete(listener)
      },
      dispatchEvent: (event: Event) => {
        for (const listener of listeners) {
          if (typeof listener === "function") {
            listener.call(list, event)
          } else {
            listener.handleEvent(event)
          }
        }
        return true
      },
    } as MediaQueryList
    state.query = query
    state.listeners = listeners
    state.legacyListeners = legacyListeners
    state.list = list
    state.lastMatch = list.matches
    states.push(state)
    return list
  })

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: matchMedia,
  })

  return {
    resize: (nextWidth: number) => {
      width = nextWidth
      updateInnerWidth(width)
      for (const state of states) {
        const matches = matchesWidth(state.query, width)
        if (matches === state.lastMatch) continue
        state.lastMatch = matches
        const event = new Event("change") as MediaQueryListEvent
        Object.defineProperties(event, {
          matches: { value: matches },
          media: { value: state.query },
        })
        state.list.dispatchEvent(event)
        for (const listener of state.legacyListeners) {
          listener.call(state.list, event)
        }
        state.list.onchange?.call(state.list, event)
      }
      window.dispatchEvent(new Event("resize"))
    },
  }
}
