# Evidence — Should I Trust This to AI?

Screenshots from a local `vite preview` build (headless Chromium, clean profile, no OS chrome;
PNGs carry no EXIF/author metadata). Desktop = 1280 px wide, mobile = 375 px.

| File(s) | What it shows |
|---|---|
| `desktop-01-landing.png` · `mobile-01-landing.png` | Landing: the pitch, the tier legend (0 / 1 / 2 / 14+), and the two worked-example presets. |
| `desktop-02-question.png` · `mobile-02-question.png` | Guided question flow — one question at a time, 0–3 answers. |
| `desktop-03-verdict-high-stakes.png` · `mobile-03-verdict-high-stakes.png` | Verdict card for the high-stakes preset, **loaded via the shared URL `?a=23322022`** (demonstrates URL-state restore). Tier 2, the visible 6-dimension scorecard (11 / 18), the "how this was computed" trace, required gates, and the copyable stop-test template. |
| `desktop-04-verdict-trivial.png` | Verdict for the trivial preset (`?a=00001000`) — Tier 0, "just let it run": the route-DOWN discipline. The same instrument routes an irreversible client email to "human in the loop" and rewording a sentence to "just let it run". |

The `?a=…` captures double as the shareable-URL round-trip proof.
