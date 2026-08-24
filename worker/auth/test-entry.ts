import { handleApiRequest, type AuthEnv } from "./api";
import { handleBusinessApiRequest } from "../business/api";
import { handleAdminApiRequest } from "../admin/api";
import { handleRealtimeApiRequest, type RealtimeEnv } from "../realtime/api";

export { MatchRoom } from "../realtime/match-room";

export default {
  fetch(request: Request, env: AuthEnv & RealtimeEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api/realtime/")) return handleRealtimeApiRequest(request, env);
    if (pathname.startsWith("/api/admin/")) return handleAdminApiRequest(request, env);
    return pathname.startsWith("/api/auth/") || pathname === "/api/profile" || pathname.startsWith("/api/account")
      ? handleApiRequest(request, env)
      : handleBusinessApiRequest(request, env);
  },
} satisfies ExportedHandler<AuthEnv & RealtimeEnv>;
