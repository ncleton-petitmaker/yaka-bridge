import type { Context } from "hono";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "./supabase.js";
import { bearerToken, getCloudAuth, setCloudAuth } from "./cloud-auth.js";

export type BridgeRole = "owner" | "admin" | "member" | "operator";

export interface BridgeMembership {
  organization_id: string;
  user_id: string;
  role: BridgeRole;
}

export interface BridgeEntitlement {
  service_id: string;
  scopes: string[];
  enabled: boolean;
}

export interface AuthzContext {
  supabase: SupabaseClient;
  user: User;
  token: string;
  organizationId: string;
  membership: BridgeMembership;
  entitlements: BridgeEntitlement[];
}

export class HttpAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.name = "HttpAuthError";
    this.status = status;
    this.code = code;
  }
}

const AUTHZ_CONTEXT_KEY = "authz";
const ADMIN_ROLES = new Set<BridgeRole>(["owner", "admin"]);

export function getAuthz(c: Context): AuthzContext | undefined {
  return (c as any).get?.(AUTHZ_CONTEXT_KEY);
}

export function setAuthz(c: Context, authz: AuthzContext): void {
  (c as any).set?.(AUTHZ_CONTEXT_KEY, authz);
}

export function organizationHeader(c: Context): string | undefined {
  const value = c.req.header("x-bridge-organization-id")?.trim();
  return value || undefined;
}

export function requireOrganizationHeader(c: Context): string {
  const organizationId = organizationHeader(c);
  if (!organizationId) {
    throw new HttpAuthError(400, "organization-required", "x-bridge-organization-id requis");
  }
  return organizationId;
}

export function isAdminRole(role: BridgeRole): boolean {
  return ADMIN_ROLES.has(role);
}

export async function requireCloudUser(dataDir: string, c: Context): Promise<{
  supabase: SupabaseClient;
  user: User;
  token: string;
}> {
  const existing = getCloudAuth(c);
  if (existing?.user && existing.token) {
    return {
      supabase: getSupabaseServerClient(dataDir),
      user: existing.user,
      token: existing.token,
    };
  }
  const token = bearerToken(c);
  if (!token) throw new HttpAuthError(401, "unauthorized", "authorization bearer requis");
  const supabase = getSupabaseServerClient(dataDir);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    throw new HttpAuthError(401, "unauthorized", "session invalide");
  }
  setCloudAuth(c, { user: data.user, token });
  return { supabase, user: data.user, token };
}

export async function requireOrganizationMember(
  dataDir: string,
  c: Context,
  options: {
    admin?: boolean;
    requiredScopes?: Array<{ serviceId: string; scopes: string[] }>;
  } = {}
): Promise<AuthzContext> {
  const existing = getAuthz(c);
  if (existing) {
    assertAuthz(existing, options);
    return existing;
  }

  const organizationId = requireOrganizationHeader(c);
  const { supabase, user, token } = await requireCloudUser(dataDir, c);
  const { data: membership, error: membershipError } = await supabase
    .from("bridge_memberships")
    .select("organization_id,user_id,role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) {
    throw new HttpAuthError(403, "organization-forbidden", "compte non autorisé sur cette organisation");
  }

  const { data: entitlementRows, error: entitlementError } = await supabase
    .from("bridge_entitlements")
    .select("service_id,scopes,enabled")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id);
  if (entitlementError) throw entitlementError;

  const authz: AuthzContext = {
    supabase,
    user,
    token,
    organizationId,
    membership: membership as BridgeMembership,
    entitlements: (entitlementRows ?? []).map((row: any) => ({
      service_id: String(row.service_id),
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      enabled: row.enabled !== false,
    })),
  };
  assertAuthz(authz, options);
  setAuthz(c, authz);
  return authz;
}

export function assertAuthz(
  authz: AuthzContext,
  options: {
    admin?: boolean;
    requiredScopes?: Array<{ serviceId: string; scopes: string[] }>;
  } = {}
): void {
  if (options.admin && !isAdminRole(authz.membership.role)) {
    throw new HttpAuthError(403, "admin-required", "accès administrateur requis");
  }
  for (const required of options.requiredScopes ?? []) {
    for (const scope of required.scopes) {
      if (!hasServiceScope(authz, required.serviceId, scope)) {
        throw new HttpAuthError(403, "scope-forbidden", `scope requis: ${scope}`);
      }
    }
  }
}

export function hasServiceScope(authz: AuthzContext, serviceId: string, scope: string): boolean {
  if (isAdminRole(authz.membership.role)) return true;
  return authz.entitlements.some((entitlement) =>
    entitlement.enabled &&
    entitlement.service_id === serviceId &&
    entitlement.scopes.includes(scope)
  );
}

export function normalizeAuthError(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof HttpAuthError) {
    return { status: err.status, body: { error: err.code } };
  }
  return { status: 500, body: { error: "internal-error" } };
}
