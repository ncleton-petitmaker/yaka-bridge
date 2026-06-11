# Design systems

yaka-bridge supports project-level design systems. The default is `claude`, but
a customer ERP can replace the design system for every module and Bridge surface
without rewriting the product architecture.

## Design system contract

A yaka-bridge design system lives in:

```text
design-systems/<id>/
  DESIGN.md
  design-system.config.json
  tokens.css
  assets/app-mark.svg
  assets/bridge-mark.svg
```

Required files:

- `DESIGN.md`: human and agent-readable rules.
- `design-system.config.json`: machine-readable manifest.
- `tokens.css`: CSS variables consumed by app, modules and Tailwind aliases.

Optional files:

- `assets/app-mark.svg`
- `assets/bridge-mark.svg`

The active system is recorded in `design-system.config.json` at the repo root.

## Applying a design system

Use:

```bash
npm run design:apply -- --design-system claude
```

For an imported system:

```bash
npm run design:apply -- \
  --design-system customer-system \
  --source /absolute/path/to/customer-system
```

The script writes:

```text
app/design-system.css
DESIGN.md
bridge/design-system.json
public/app-mark.svg
public/bridge-mark.svg
design-system.config.json
```

`app/layout.tsx` imports `app/design-system.css` after `globals.css`, so the
active design system overrides template defaults while preserving shared shell
classes.

Bridge reads `bridge/design-system.json` in its setup window and the Bridge
build copies that file into `dist/bridge/`.

## Brief field

New projects choose a design system at first setup:

```yaml
DESIGN_SYSTEM: claude
```

To use an imported source during generation:

```yaml
DESIGN_SYSTEM: customer-system
DESIGN_SYSTEM_SOURCE: /absolute/path/to/customer-system
```

If absent, the factory uses `claude`.

## Refactoring all modules and Bridge

Applying tokens is only the first step. A full visual migration must use the
global skill:

```text
Use the yaka-bridge-refactor-design-system skill to apply this design system to
all modules, admin pages and Bridge surfaces.
```

That skill audits:

- `app/`
- `components/`
- `modules/`
- `bridge/`
- `public/`
- `tailwind.config.ts`
- docs and screenshots when relevant

It must remove stale visual assumptions, preserve agentic/business behavior,
and run the full verification suite.

## Using nexu-io/open-design

Recommended option for creating a new customer design system:

1. Use `nexu-io/open-design` to explore and generate a design direction:
   <https://github.com/nexu-io/open-design>
2. Export or write a clear `DESIGN.md`.
3. Convert it to the yaka-bridge contract:
   - `design-system.config.json`
   - `tokens.css`
   - Bridge token subset
   - app and Bridge marks
4. Run `npm run design:apply`.
5. Run the refactor skill.
6. Verify with build, factory and visual review.

Do not import an open-design output blindly. The final yaka-bridge contract
must be auditable, tokenized, accessible, and free of customer secrets.

## Required token families

Every design system must provide:

- surfaces: `--bg`, `--surface`, `--subtle`, `--bg-muted`;
- borders: `--border`, `--border-strong`, `--border-soft`;
- text: `--fg`, `--fg-strong`, `--muted`, `--soft`, `--faint`;
- accent: `--accent`, `--accent-strong`, `--accent-soft`, `--accent-tint`;
- status: green, blue, purple, red, amber;
- elevation: `--shadow-xs`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`;
- shape: `--radius-sm`, `--radius`, `--radius-lg`, `--radius-pill`;
- type: `--serif`, `--sans`, `--mono`;
- motion: `--ease`, `--t-fast`.

## Acceptance checklist

Before merging a design system change:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
npm run security:grep
npm run factory:check
```

Also verify:

- generated ERP receives the selected design system;
- Bridge setup window receives the Bridge token subset;
- no module keeps hardcoded legacy colors;
- no text overflows after typography/radius/spacing changes;
- light and dark modes are readable if both are supported;
- screenshots or browser review cover desktop and mobile widths.
