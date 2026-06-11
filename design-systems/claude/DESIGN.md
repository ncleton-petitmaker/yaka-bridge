# Claude design system

This is the default yaka-bridge design system. It is intentionally quiet,
dense and operational: suitable for ERP dashboards, module workspaces, Bridge
setup screens and repeated daily use.

## Intent

- Prioritize readability, scan speed and trust over decoration.
- Keep ERP screens compact and calm.
- Use warm neutral surfaces and a single restrained accent.
- Reserve status colors for status only.
- Make every module feel like part of one product.

## Product surfaces

This design system must apply to:

- Next.js app shell and admin pages.
- Every module under `modules/<moduleId>/`.
- Bridge desktop windows and setup flows.
- Generated customer ERP projects.

## Core rules

- Components consume CSS variables, not hardcoded colors.
- Cards are for repeated records, framed tools and modals only.
- Do not nest cards inside cards.
- Keep radius restrained.
- Avoid decorative gradients, blobs, bokeh, mascots and one-note palettes.
- Buttons use text only for commands; compact tools use icons and tooltips.
- Visible UI copy should not explain the software itself.
- Every module dashboard uses the shared shell, typography, spacing and status
  vocabulary.

## Tokens

The canonical token file is `tokens.css`. Required variables are listed in
`design-system.config.json`.

Token groups:

- surfaces: `--bg`, `--surface`, `--subtle`, `--bg-muted`;
- borders: `--border`, `--border-strong`, `--border-soft`;
- text: `--fg`, `--fg-strong`, `--muted`, `--soft`, `--faint`;
- accent: `--accent`, `--accent-strong`, `--accent-soft`, `--accent-tint`;
- status: green, blue, purple, red, amber;
- elevation: `--shadow-xs` through `--shadow-lg`;
- shape: `--radius-sm`, `--radius`, `--radius-lg`, `--radius-pill`;
- type: `--serif`, `--sans`, `--mono`;
- motion: `--ease`, `--t-fast`.

## Typography

- Serif headings signal authority without marketing tone.
- Sans body is the default for operational density.
- Mono is reserved for ids, counters, logs, tokens and technical references.
- Letter spacing is zero except small uppercase eyebrow labels.

## Bridge

Bridge has a smaller setup UI but must use the same product identity:

- same accent;
- same neutral background;
- same status colors;
- same mark family;
- no separate visual language.

The Bridge subset is stored in `bridge.tokens` inside
`design-system.config.json` and copied to `bridge/design-system.json` by
`scripts/apply-design-system.mjs`.

## Change process

To replace this system:

1. Add or import a new design system under `design-systems/<id>/`.
2. Ensure it has `DESIGN.md`, `design-system.config.json` and `tokens.css`.
3. Run `npm run design:apply -- --design-system <id>`.
4. Run the design refactor skill against all app, module and Bridge surfaces.
5. Run typecheck, tests, build, security grep and factory check.
