// index.ts
import { handleRequest } from "./router";

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
