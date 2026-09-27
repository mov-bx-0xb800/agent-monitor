# Product icon

The extension listing uses [media/icon.png](../media/icon.png), generated with OpenAI's built-in image-generation tool. The sidebar and editor tab use [media/monitor.svg](../media/monitor.svg), a simplified, theme-aware vector interpretation of the same monitor, activity trace and endpoint. The raster icon is bundled locally; displaying it makes no external request.

The PNG retains its generated pixels. Nonessential metadata chunks were removed for the repository's distribution checks. No third-party logo was used as a reference.

## Generation prompt

Use case: logo-brand. Create one finished square product icon for Agent Monitor, a desktop code-editor extension for observing local coding-agent activity, viewing tool images and directing a chat's focus. Design a single distinctive geometric monitor-and-signal symbol: a strong rounded monitor outline enclosing a very simple angular activity trace that subtly suggests an M, with one small terminal dot. Flat, precise, vector-like graphic; confident proportions and generous negative space. Restrained monochrome light mark on a deep dark neutral square background; optional single muted green activity dot, consistent with an editor activity indicator. Icon fills roughly 75 percent of the square and remains immediately legible at 32 pixels. Straight-on, centred, equal margins. No text, letters, words, robot faces, eyes, brains, sparkles, circuit-board decoration, shields, gradients, 3D, shadows, mockups, grids or multiple options. Output the icon artwork only, 1024 by 1024.

## Refinement prompt

Edit this Agent Monitor extension icon. Keep the exact monitor, angular M-shaped activity line, green endpoint and overall proportions. Remove ALL glow, bloom, shadows, surface texture and gradients. Make the mark flat solid off-white, the dot flat solid green, and the entire square canvas a single opaque charcoal colour (#171C23), including outside the monitor. Crisp clean geometric edges, evenly weighted strokes. No transparency, no vignette, no 3D, no text. This is a finished small extension-list icon, not an illuminated sign.

## Extension integration

The manifest's `icon` field points to the bundled PNG. Its dimensions exceed the [VS Code extension icon minimum](https://code.visualstudio.com/api/references/extension-manifest#fields). Keep the listing icon in the distribution image allowlist when changing its path.
