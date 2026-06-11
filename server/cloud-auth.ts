import type { Context } from "hono";
import type { User } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { getSupabaseServerClient } from "./supabase.js";

export interface CloudAuthContext {
  user: User;
  token: string;
}

const AUTH_CONTEXT_KEY = "cloudAuth";

export function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

export function isCloudAuthRequired(): boolean {
  return isTruthyEnv(process.env.REQUIRE_AUTH);
}

export function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

export function safeTokenEquals(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function requireSupabaseUser(dataDir: string, c: Context): Promise<CloudAuthContext> {
  const token = bearerToken(c);
  if (!token) throw new Error("authorization bearer requis");
  const supabase = getSupabaseServerClient(dataDir);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw error ?? new Error("session invalide");
  const auth = { user: data.user, token };
  setCloudAuth(c, auth);
  return auth;
}

export function setCloudAuth(c: Context, auth: CloudAuthContext): void {
  (c as any).set?.(AUTH_CONTEXT_KEY, auth);
}

export function getCloudAuth(c: Context): CloudAuthContext | undefined {
  return (c as any).get?.(AUTH_CONTEXT_KEY);
}

