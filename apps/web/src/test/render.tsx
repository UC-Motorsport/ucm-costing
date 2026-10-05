import { StrictMode, type PropsWithChildren, type ReactElement } from "react"
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import {
  render as testingLibraryRender,
  type RenderOptions,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

interface RenderWithProvidersOptions
  extends Omit<RenderOptions, "wrapper"> {
  queryClient?: QueryClient
  strict?: boolean
}

export function renderWithProviders(
  ui: ReactElement,
  {
    queryClient = createTestQueryClient(),
    strict = true,
    ...renderOptions
  }: RenderWithProvidersOptions = {},
) {
  const user = userEvent.setup()

  function Providers({ children }: PropsWithChildren) {
    const content = (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    )
    return strict ? <StrictMode>{content}</StrictMode> : content
  }

  return {
    user,
    queryClient,
    ...testingLibraryRender(ui, {
      wrapper: Providers,
      ...renderOptions,
    }),
  }
}

export {
  act,
  fireEvent,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react"
