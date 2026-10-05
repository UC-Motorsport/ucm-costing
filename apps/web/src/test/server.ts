import { setupServer } from "msw/node"

import { defaultHandlers } from "@/test/handlers"

export const server = setupServer(...defaultHandlers)
