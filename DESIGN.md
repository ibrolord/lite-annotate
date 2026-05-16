# Lite Annotate Design Context

## Visual Register

Product UI. Design serves fast engineering review.

## Theme

Developer founder reviewing bug reports on a laptop during a live demo in a bright room, switching between browser, GitHub, and terminal. Use a light interface with high contrast and disciplined accents so projected text stays legible.

## Color Strategy

Restrained product palette using OKLCH tokens:

- Ink: near-black neutral tinted toward blue.
- Canvas: warm-white neutral, never pure white.
- Panel: slightly lifted neutral.
- Accent: focused blue for links, primary actions, and current state.
- Success: green only for verified states.
- Warning: amber only for pending or dry-run cautions.
- Danger: red only for PR-opening or failure states.

## Typography

System UI stack. Compact product scale with clear contrast:

- Page title: 24 to 28px, 700 weight.
- Section title: 15 to 17px, 700 weight.
- Body: 14 to 15px, 400 to 500 weight.
- Metadata: 12 to 13px, 500 weight.
- Code and JSON: monospace, 12px, contained behind details or lower-priority sections when possible.

## Layout

- Prefer an app shell with a top rail and clear primary actions.
- Use full-width bands or split panes for major task areas.
- Cards only for discrete repeated records or clearly framed tools.
- Avoid nested cards.
- Keep critical demo narrative above raw JSON.

## Components

- Buttons: consistent 6px radius, 44px minimum touch target where practical.
- Pills: compact status indicators with semantic color.
- Tables: dense but readable, with sticky or high-contrast headers where useful.
- Details/disclosure: use for raw JSON so engineers can inspect without overwhelming judges.
- Focus states: visible blue ring, not browser-default only.

## Motion

Minimal state feedback only. 150 to 200ms ease-out transitions on hover, focus, and disclosure changes. Respect reduced motion.
