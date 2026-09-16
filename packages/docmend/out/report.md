# docmend report

Across 70 documentation pages (8 of Ryan's own: 4 public repos and 12 getsmartai.ai page(s); 50 external quickstarts snapshotted 2026-09-11) with 748 links, 267 code blocks and 5 version pins, 268 drift findings; 86 fixes proposed, 25 (29.1%, 95% Wilson CI 20.5-39.4%) pass independent re-verification.

Of the 86 fixes proposed, 19 are safe to auto-apply without human review; 0 finding(s) rely on an LLM judgment ([SIMULATED], confidence capped at 0.8) and are never auto-applied.

## Corpus
- Pages: 70 (8 own-repo across 4 repo(s), 12 site, 50 external)
- Links checked: 748 · Code blocks checked: 267 · Version pins checked: 5

## Drift by category
- broken-link: 45
- broken-relative-path: 3
- missing-prerequisite: 79
- placeholder-text: 24
- redirected-link: 96
- stale-pin: 1
- unparseable-snippet: 19
- version-drift: 1

## Proposals
- `0006c5ba3b:D-pin:0:pin-bump` (pin-bump, page `0006c5ba3b`): reverify=fail, safe_to_auto_apply=false, independence=measured — registry latest (0.29.0) shares the pin's major version (diff refused: not-found)
- `0ecf3d52d5:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `0ecf3d52d5`): reverify=fail, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (discord.gg -> discord.com) (diff refused: ambiguous)
- `1c11cc422d:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `1c11cc422d`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `1f14929d16:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `1f14929d16`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `23699db8a2:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `23699db8a2`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `23699db8a2:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `23699db8a2`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `23699db8a2:D-redirect:3:redirect-rewrite` (redirect-rewrite, page `23699db8a2`): reverify=fail, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (astral.sh -> releases.astral.sh) (diff refused: ambiguous)
- `23699db8a2:D-redirect:4:redirect-rewrite` (redirect-rewrite, page `23699db8a2`): reverify=pass, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (astral.sh -> releases.astral.sh)
- `346563dc9a:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `346563dc9a`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `346563dc9a:D-redirect:2:redirect-rewrite` (redirect-rewrite, page `346563dc9a`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `346563dc9a:D-redirect:3:redirect-rewrite` (redirect-rewrite, page `346563dc9a`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `346563dc9a:D-redirect:4:redirect-rewrite` (redirect-rewrite, page `346563dc9a`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `346563dc9a:D-redirect:5:redirect-rewrite` (redirect-rewrite, page `346563dc9a`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `50935316f4:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `50935316f4`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `6a2a441be6:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `6a2a441be6`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `6a6d09d406:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `6a6d09d406`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `6a6d09d406:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `6a6d09d406`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `6a6d09d406:D-redirect:2:redirect-rewrite` (redirect-rewrite, page `6a6d09d406`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `6a6d09d406:D-redirect:3:redirect-rewrite` (redirect-rewrite, page `6a6d09d406`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `9da32fdd0f:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `9da32fdd0f`): reverify=pass, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (claude.ai -> claude.com)
- `afcfe928f5:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `afcfe928f5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `bdb5d3ea8a:D-redirect:3:redirect-rewrite` (redirect-rewrite, page `bdb5d3ea8a`): reverify=fail, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (discord.gg -> discord.com) (diff refused: ambiguous)
- `c23bd76dba:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `c23bd76dba`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `c49ae859c2:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `c49ae859c2`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `c512541be5:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `c512541be5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `c512541be5:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `c512541be5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `c512541be5:D-redirect:2:redirect-rewrite` (redirect-rewrite, page `c512541be5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `c512541be5:D-redirect:3:redirect-rewrite` (redirect-rewrite, page `c512541be5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `c512541be5:D-redirect:4:redirect-rewrite` (redirect-rewrite, page `c512541be5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `c512541be5:D-redirect:5:redirect-rewrite` (redirect-rewrite, page `c512541be5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `c512541be5:D-redirect:6:redirect-rewrite` (redirect-rewrite, page `c512541be5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `c6dda05c5e:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `c6dda05c5e`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `c6dda05c5e:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `c6dda05c5e`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `c6dda05c5e:D-redirect:2:redirect-rewrite` (redirect-rewrite, page `c6dda05c5e`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `c6dda05c5e:D-redirect:3:redirect-rewrite` (redirect-rewrite, page `c6dda05c5e`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `c6dda05c5e:D-redirect:4:redirect-rewrite` (redirect-rewrite, page `c6dda05c5e`): reverify=pass, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (github.com -> github-production-user-asset-6210df.s3.amazonaws.com)
- `cf919a1dd2:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `cf919a1dd2`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `cf919a1dd2:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `cf919a1dd2`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `cf919a1dd2:D-redirect:2:redirect-rewrite` (redirect-rewrite, page `cf919a1dd2`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `d7090aa787:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `d7090aa787`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `e86ef3b990:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `e86ef3b990`): reverify=pass, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (docs.konghq.com -> developer.konghq.com)
- `e86ef3b990:D-redirect:2:redirect-rewrite` (redirect-rewrite, page `e86ef3b990`): reverify=fail, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (konghq.com -> developer.konghq.com) (diff refused: ambiguous)
- `e86ef3b990:D-redirect:3:redirect-rewrite` (redirect-rewrite, page `e86ef3b990`): reverify=pass, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (docs.konghq.com -> developer.konghq.com)
- `eac8dd289f:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `eac8dd289f`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eac8dd289f:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `eac8dd289f`): reverify=fail, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (huggingface.co -> discord.com) (diff refused: not-found)
- `eac8dd289f:D-redirect:2:redirect-rewrite` (redirect-rewrite, page `eac8dd289f`): reverify=fail, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (huggingface.co -> endpoints.huggingface.co) (diff refused: not-found)
- `eb58eaecdc:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `eb58eaecdc:D-redirect:10:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:11:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:16:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:17:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:2:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:3:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:4:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:5:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:6:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:7:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `eb58eaecdc:D-redirect:8:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (discord.gg -> discord.com) (diff refused: ambiguous)
- `eb58eaecdc:D-redirect:9:redirect-rewrite` (redirect-rewrite, page `eb58eaecdc`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `f280b85dd5:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:10:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:11:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:12:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:13:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:14:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:15:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `f280b85dd5:D-redirect:16:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:17:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: ambiguous)
- `f280b85dd5:D-redirect:18:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:19:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:2:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:20:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:21:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:3:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:4:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:5:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:6:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:7:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:8:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f280b85dd5:D-redirect:9:redirect-rewrite` (redirect-rewrite, page `f280b85dd5`): reverify=fail, safe_to_auto_apply=false, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL (diff refused: not-found)
- `f7c3d5eecc:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `f7c3d5eecc`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `f7c3d5eecc:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `f7c3d5eecc`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `fcb531f924:D-redirect:0:redirect-rewrite` (redirect-rewrite, page `fcb531f924`): reverify=pass, safe_to_auto_apply=true, independence=measured — every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL
- `fcb531f924:D-redirect:1:redirect-rewrite` (redirect-rewrite, page `fcb531f924`): reverify=pass, safe_to_auto_apply=false, independence=measured — cross-host permanent redirect (docs.agpt.co -> agpt.co)

## Pages with the most drift
- `8d6d049795`: 43 counted finding(s)
- `f280b85dd5`: 24 counted finding(s)
- `f7c3d5eecc`: 17 counted finding(s)
- `eb58eaecdc`: 16 counted finding(s)
- `fc4309aa67`: 16 counted finding(s)
- `346563dc9a`: 14 counted finding(s)
- `c512541be5`: 11 counted finding(s)
- `1f14929d16`: 8 counted finding(s)
- `1c11cc422d`: 7 counted finding(s)
- `c6dda05c5e`: 7 counted finding(s)

## LLM spend (docmend:prereq-prose)
- calls: 0 · errors: 0 · mock: 0 · cost: $0.0000

## Not measured
- snippet execution (parsing only; nothing is run)
- prose quality of any generated fix
- semantic correctness of any fix (only mechanical re-verification, never meaning)
- a 403 is counted as broken, never distinguished from a genuinely dead link
