import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

interface Route {
  readonly method: string;
  readonly path: string;
  readonly handler: Handler;
}

/**
 * A deliberately minimal router: exact method plus path, no parameters, no middleware
 * stack. The API is a handful of endpoints, and this is less code than configuring a
 * framework would be. Revisit if path parameters ever appear.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), path, handler });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.add('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.add('POST', path, handler);
  }

  /** Returns the handler, or `null` if nothing matches the path at all. */
  match(method: string, path: string): Handler | null | 'method_not_allowed' {
    let pathExists = false;

    for (const route of this.routes) {
      if (route.path !== path) continue;
      pathExists = true;
      if (route.method === method.toUpperCase()) return route.handler;
    }

    return pathExists ? 'method_not_allowed' : null;
  }
}
