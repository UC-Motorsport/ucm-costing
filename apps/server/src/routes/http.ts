import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

export function asyncRoute(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

export function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("route-parameter-required");
  }
  return value;
}
