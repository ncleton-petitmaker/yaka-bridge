#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const args = parseArgs(process.argv.slice(2));
const secret = args.secret ?? process.env.BRIDGE_TOKEN_SECRET;
if (!secret) fail("BRIDGE_TOKEN_SECRET or --secret is required.");

const ttlSeconds = Number(args.ttlSeconds ?? args.ttl ?? 60 * 60 * 24 * 30);
if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60) fail("--ttl must be at least 60 seconds.");

const nowSeconds = Math.floor(Date.now() / 1000);
const serviceIds = values(args.serviceId ?? args.serviceIds ?? args.services);
const scopes = values(args.scope ?? args.scopes);
const payload = {
  jti: randomUUID(),
  organizationId: required(args.organizationId ?? args.org, "--organization-id"),
  bridgeId: required(args.bridgeId, "--bridge-id"),
  deviceId: required(args.deviceId, "--device-id"),
  userId: args.userId,
  serviceIds,
  scopes,
  iat: nowSeconds,
  exp: nowSeconds + ttlSeconds,
};

const payloadPart = Buffer.from(JSON.stringify(stripUndefined(payload))).toString("base64url");
const signature = createHmac("sha256", secret).update(payloadPart).digest("base64url");
const token = `brg_${payloadPart}.${signature}`;
const row = {
  organization_id: payload.organizationId,
  bridge_id: payload.bridgeId,
  device_id: payload.deviceId,
  user_id: payload.userId ?? null,
  token_hash: sha256(token),
  token_jti_hash: sha256(payload.jti),
  service_ids: serviceIds,
  scopes,
  expires_at: new Date(payload.exp * 1000).toISOString(),
  created_by: args.createdBy ?? payload.userId ?? null,
};

if (truthy(args.register)) {
  await registerToken(row);
  console.log(JSON.stringify({ token, registered: true, expiresAt: row.expires_at }, null, 2));
} else {
  console.log(JSON.stringify({
    token,
    registered: false,
    tokenHash: row.token_hash,
    tokenJtiHash: row.token_jti_hash,
    expiresAt: row.expires_at,
    sql: insertSql(row),
  }, null, 2));
}

async function registerToken(row) {
  const url = args.supabaseUrl ?? process.env.SUPABASE_URL;
  const serviceRoleKey = args.supabaseServiceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    fail("--register requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  const supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase
    .from("bridge_device_tokens")
    .insert(row);
  if (error) fail(error.message);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    out[key.slice(2).replace(/-([a-z])/g, (_m, chr) => chr.toUpperCase())] =
      value && !value.startsWith("--") ? value : "true";
    if (value && !value.startsWith("--")) i += 1;
  }
  return out;
}

function required(value, label) {
  if (!value) fail(`${label} is required.`);
  return value;
}

function values(value) {
  if (!value || value === "true") return [];
  return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function stripUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function insertSql(row) {
  return [
    "insert into public.bridge_device_tokens",
    "  (organization_id, bridge_id, device_id, user_id, token_hash, token_jti_hash, service_ids, scopes, expires_at, created_by)",
    "values",
    `  (${sql(row.organization_id)}::uuid, ${sql(row.bridge_id)}, ${sql(row.device_id)}, ${row.user_id ? `${sql(row.user_id)}::uuid` : "null"}, ${sql(row.token_hash)}, ${sql(row.token_jti_hash)}, ${sqlArray(row.service_ids)}, ${sqlArray(row.scopes)}, ${sql(row.expires_at)}::timestamptz, ${row.created_by ? `${sql(row.created_by)}::uuid` : "null"});`,
  ].join("\n");
}

function sql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlArray(values) {
  return `array[${values.map(sql).join(", ")}]::text[]`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
