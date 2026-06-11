import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bridgeSql = readFileSync("supabase/migrations/20260606120000_bridge_control_plane.sql", "utf8");
const purchasingSql = readFileSync("supabase/migrations/20260611120000_purchasing_module.sql", "utf8");

test("bridge control-plane migration defines revocable tokens and atomic job leasing", () => {
  assert.match(bridgeSql, /create table if not exists public\.bridge_device_tokens/i);
  assert.match(bridgeSql, /token_hash text not null unique/i);
  assert.match(bridgeSql, /revoked_at timestamptz/i);
  assert.match(bridgeSql, /create or replace function public\.bridge_poll_jobs/i);
  assert.match(bridgeSql, /for update skip locked/i);
  assert.match(bridgeSql, /create or replace function public\.bridge_consume_launch_ticket/i);
  assert.match(bridgeSql, /grant execute on function public\.bridge_poll_jobs/i);
});

test("module migrations use scope-based RLS for purchasing data", () => {
  assert.match(bridgeSql, /create or replace function public\.bridge_has_scope/i);
  assert.match(purchasingSql, /alter table public\.purchasing_suppliers enable row level security/i);
  assert.match(purchasingSql, /alter table public\.purchasing_quotes enable row level security/i);
  assert.match(purchasingSql, /service:purchasing:read/i);
  assert.match(purchasingSql, /service:purchasing:write/i);
  assert.match(purchasingSql, /service:purchasing:admin/i);
});
