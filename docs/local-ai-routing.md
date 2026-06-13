# Local AI routing

Bridge supports two agentic execution modes:

- `codex-cloud`: default. Runs through ChatGPT Codex.
- `codex-lmstudio`: local opt-in. Runs `codex exec --oss --local-provider lmstudio`.

The product rule is cloud by default. Local execution is selected only by an
admin policy, a service manifest, an action manifest or an explicit job payload.
There is no cloud fallback when a local route is selected and LM Studio is not
ready.

## Admin policy

The admin surface is `/admin/agent-routing`.

The admin controls:

- whether LM Studio should be installed on Bridge desktops;
- the default local model for the organization;
- service/action routing policy: cloud or local;
- privacy: `normal`, `sensitive` or `local-only`;
- the push-to-talk model and default shortcut policy.

The policy is persisted in the existing `bridge_services.manifest` JSON field.
No extra SQL migration is required for routing policy changes.

## User surface

Users do not choose cloud versus local during setup. If the admin enables local
AI, Bridge prepares LM Studio after the next sync. If the admin enables local
push-to-talk, Bridge downloads the configured Parakeet model after the next
sync.

The user-facing settings page shows diagnostics only. It does not expose the
provider selector. The desktop Bridge menu/panel may allow the user to change
the push-to-talk shortcut when the admin permits it.

## LM Studio provisioning

Bridge prepares LM Studio in this order:

1. install the official LM Studio headless runtime first:
   `https://lmstudio.ai/install.sh` on macOS/Linux or
   `https://lmstudio.ai/install.ps1` on Windows;
2. if the headless runtime is unavailable, fall back to the desktop package,
   using `/Applications/LM Studio.app` on macOS and launching it hidden only as a
   last-resort bootstrap path;
3. start the local daemon and server with `lms daemon up` and
   `lms server start --port 1234`;
4. check `/v1/models`;
5. run `lms get <model> --yes` if the admin model is not installed;
6. run `lms load <model> --identifier <model> --context-length 32768 --yes`;
7. verify that `/v1/models` exposes the exact configured model id.

The v1 target is local-only LM Studio. Remote LM Studio, Ollama, Apple
Foundation Models and Microsoft Foundry are intentionally outside this runtime
path.

## Model recommendation

The admin page includes a hardware recommendation based on:

- system memory;
- CPU count;
- Apple Silicon detection;
- NVIDIA VRAM when `nvidia-smi` is available.

Low-memory machines are kept cloud-first. The default local model is
`ibm/granite-4-micro`, a small LM Studio model that is suitable as the portable
baseline across ordinary PCs and Macs. More capable Apple unified-memory or
NVIDIA machines can be offered `openai/gpt-oss-20b`; premium machines can be
offered `openai/gpt-oss-120b`.

## Push-to-talk

Bridge ships a native `bridge-voice` sidecar. It uses:

- `handy-keys` for native press/release hotkey events;
- `cpal` for microphone capture;
- `transcribe-rs` with Parakeet for local transcription;
- `enigo` for local paste insertion.

The default model is `parakeet-tdt-0.6b-v3-int8`. It is downloaded on demand,
not committed to the repository.

## Verification

Core checks:

```bash
npm run typecheck
npm test
npm run build
npm run bridge:build
npm run security:grep
```

Packaging checks:

```bash
npm run bridge:pack:mac
npm run bridge:pack:win
npm run bridge:verify-assets -- --target darwin
npm run bridge:verify-assets -- --target win32
```

The push-to-talk sidecar is native. A packaged build requires the sidecar for
the target platform. Build macOS on macOS and Windows on Windows, or provide a
prebuilt sidecar through `BRIDGE_VOICE_SIDECAR_PATH` when cross-packaging.
CI runs `scripts/build-bridge.mjs --require-voice-sidecar` on macOS and Windows
so missing native sidecars fail before release packaging.

Manual LM Studio smoke:

```bash
lms server start --port 1234
lms get ibm/granite-4-micro
lms load ibm/granite-4-micro --identifier ibm/granite-4-micro
curl http://127.0.0.1:1234/v1/models
```
