import { localhostAllowedOrigins, originValidationResponse } from '@modelcontextprotocol/server';

export interface OriginPolicy {
  validate(request: Request): Response | undefined;
}

export function createOriginPolicy(allowedHostnames: readonly string[] = localhostAllowedOrigins()): OriginPolicy {
  const allowed = [...new Set(allowedHostnames.map((value) => {
    try { return new URL(value).hostname; } catch { return value; }
  }))];
  return {
    validate(request: Request): Response | undefined {
      return originValidationResponse(request, allowed);
    },
  };
}
