# Evidence

Verification captures for the CS Prompt Field Kit build. All screenshots are
metadata-null (no tEXt / iTXt / eXIf chunks) and show the local production build.

## Screenshots

| File | Viewport | Page |
| --- | --- | --- |
| `sc-01-index-desktop.png` | 1280 | Home grid, all 18 cards |
| `sc-02-card-saveplay-desktop.png` | 1280 | Card detail: At-Risk Save Play |
| `sc-03-rollout-desktop.png` | 1280 | Rollout: five-rung adoption ladder |
| `sc-04-index-mobile.png` | 375 | Home grid, mobile |
| `sc-05-card-postmortem-mobile.png` | 375 | Card detail: Churn Post-Mortem, mobile |
| `sc-06-rollout-mobile.png` | 375 | Rollout, mobile |

## Verified behaviour

- `npm run build` green: 20 pages built (18 cards, home, rollout); the card gate
  (`prebuild`) passes at 18 cards, all five elements present.
- Home grid renders all 18 cards; search and lifecycle filters work (Rescue filter
  returns the 4 rescue cards).
- Copy-to-clipboard works: the clipboard receives the exact template text.
- `/rollout` returns 200 and renders all five rungs; its call-to-action links home.
- No horizontal overflow at 375 px on home, card, or rollout.
- Zero console errors on every page.
