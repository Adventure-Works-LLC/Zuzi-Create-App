# Palette — pinned

Two-mode warm palette. Studio is the dark working canvas; Login is the bright friendly
front door. Hex codes here are the source of truth — `app/globals.css` mirrors them. If
you need to change a value, update both this file AND `globals.css`, never just one.

## Studio (dark, warm-near-black, museum-tonal)

The default app surface. Cool grays read as "developer tool"; Zuzi's work is figurative,
earthy, oil-paint warm — chrome should match.

| Token             | Hex       | Role                                              |
|-------------------|-----------|---------------------------------------------------|
| `--bg`            | `#0E0C0A` | Warm near-black, behind everything                |
| `--surface`       | `#1A1816` | Cards, inputs, lightbox panels                    |
| `--surface-2`     | `#242220` | Hover / pressed                                   |
| `--hairline`      | `#2A2724` | 1px borders, dividers (use these, not shadows)    |
| `--text`          | `#EDE7DE` | Warm cream, primary text                          |
| `--text-mute`     | `#8A8278` | Captions, timestamps, secondary text              |
| `--accent`        | `#C9A878` | Warm brass — buttons, focus rings, progress       |
| `--accent-hi`     | `#E0BE8C` | Accent hover                                      |
| `--danger`        | `#B85C4A` | Offline / critical only — never default           |

Wired in `app/globals.css` under the `.dark` selector. Studio routes wrap children in a
`<div className="dark">` via `app/(app)/layout.tsx`, so all of Tailwind's `bg-background`,
`text-foreground`, etc. resolve to these warm-dark values inside the studio.

## Login (light, warm, inviting)

The "front door". Bright, friendly, modern — deliberate contrast to the contemplative
studio that follows. Off-white with a warm undertone, not a sterile clinical white.

| Token                | Hex       | Role                                            |
|----------------------|-----------|-------------------------------------------------|
| `--login-bg`         | `#FAF7F2` | Off-white with warm undertone                   |
| `--login-surface`    | `#FFFFFF` | Form card                                       |
| `--login-text`       | `#1A1612` | Warm near-black for type                        |
| `--login-text-mute`  | `#7A7368` | Secondary text                                  |
| `--login-accent`     | `#C9602B` | Terracotta — friendly, art-world warm           |
| `--login-hairline`   | `#E8E2D6` | Very soft warm grey, 1px dividers               |

Wired in `app/globals.css` under the `:root` selector (default light). The `(auth)` route
group does NOT add `.dark`, so these tokens win on the login screen.

## Background atmosphere

The login form sits on a soft warm radial gradient blob (peach/cream) rendered inline in
`app/(auth)/login/page.tsx`. Don't replace it with a photograph in v1 — the gradient
keeps the asset list to zero and the front door visually quiet.

## Typography

| Variable          | Family                         | Use                                |
|-------------------|--------------------------------|------------------------------------|
| `--font-sans`     | Inter (next/font/google)       | UI body, inputs, buttons           |
| `--font-display`  | Fraunces (opsz, SOFT axes)     | Wordmark, drawer headers, login    |

Loaded in `app/layout.tsx`. Use Tailwind utility `font-display` for the Fraunces face;
default `font-sans` everywhere else. 14/16/20px UI sizes; 28–48px display.

## Radii

`--radius: 0.625rem` (10px). Tailwind aliases `rounded-md` → 80% of radius, `rounded-lg`
→ full radius, `rounded-xl` → 140%. Tiles and cards: `rounded-lg` (10px). Chips:
`rounded` (4px equivalent).

## What NOT to do

- No drop shadows except a single soft shadow under the lightbox modal. Use hairlines.
- No gradients in chrome (the login background atmosphere is the one exception).
- No cool-gray fallback colors. Anything that needs to read as "muted" uses `--text-mute`,
  not a neutral gray.
- No sky-blue links / accents. The accent is brass (Studio) or terracotta (Login).
