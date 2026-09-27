# Third-party assets

The 16 inline SVG icons in `media/icons.js` are from [Microsoft Codicons](https://github.com/microsoft/vscode-codicons), commit `a114bce46804d3d3ee88e7384c836910d140a35f`. Their SVG paths are unchanged; presentation attributes are applied at render time. See [icon licence](CODICONS-LICENSE.txt). No icon font, JavaScript dependency or external image request is used.

Provider marks in `media/providers.js` are from [Lobe Icons](https://github.com/lobehub/lobe-icons), commit `329f378cbd1a88f45b60cd096b9111ce16f3ea39`: `packages/static-svg/icons/openai.svg`, `claude.svg` and `cursor.svg`. Paths are unchanged; inline styles are removed at render time and theme colours applied. See the [MIT licence](LOBE-ICONS-LICENSE.txt). Brand marks identify their respective agents; ownership remains with their respective owners. Only these three SVGs are bundled, with no library or network request.
