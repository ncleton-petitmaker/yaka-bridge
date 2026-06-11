import test from "node:test";
import assert from "node:assert/strict";
import {
  bridgeTokenHash,
  createSignedBridgeToken,
  parseSignedBridgeToken,
} from "../../server/bridge-control-plane";

const secret = "test-secret-with-enough-entropy";

test("signed bridge tokens round-trip and expose a stable hash for revocation lookup", () => {
  const payload = {
    jti: "0c95a626-5511-4d99-b98d-7b9cbb93ffb5",
    organizationId: "9c3b6f91-2074-4d6e-8c4a-3514da2d986d",
    bridgeId: "bridge-demo",
    deviceId: "device-demo",
    serviceIds: ["purchasing"],
    scopes: ["service:purchasing:read", "codex:run"],
    iat: 1_800_000_000,
    exp: 1_900_000_000,
  };
  const token = createSignedBridgeToken(payload, secret);
  assert.match(token, /^brg_/);
  assert.equal(bridgeTokenHash(token).length, 64);
  assert.deepEqual(parseSignedBridgeToken(token, secret, 1_800_000_001_000), payload);
});

test("signed bridge tokens reject tampering", () => {
  const token = createSignedBridgeToken({
    jti: "73669bb4-b32e-4481-8f55-8e63ad31744d",
    organizationId: "9c3b6f91-2074-4d6e-8c4a-3514da2d986d",
    bridgeId: "bridge-demo",
    deviceId: "device-demo",
    exp: 1_900_000_000,
  }, secret);
  assert.throws(() => parseSignedBridgeToken(`${token}tampered`, secret, 1_800_000_001_000), /invalid-bridge-token/);
});

test("signed bridge tokens reject expired payloads", () => {
  const token = createSignedBridgeToken({
    jti: "887f7906-8947-4048-9ba6-8e4829435f5e",
    organizationId: "9c3b6f91-2074-4d6e-8c4a-3514da2d986d",
    bridgeId: "bridge-demo",
    deviceId: "device-demo",
    exp: 1_800_000_000,
  }, secret);
  assert.throws(() => parseSignedBridgeToken(token, secret, 1_800_000_001_000), /expired-bridge-token/);
});
