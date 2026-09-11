# Skillcheck — Lessons Log

Append-only. Format: `[date] | what went wrong | rule to prevent it`

2026-08-25 | Screening rules calibrated only against synthetic fixtures over-fired on the
real official cohort: EX-002 flagged every doc that NAMED `ANTHROPIC_API_KEY` (~55 hits),
UNI-001 flagged the legitimate leading BOM in bundled `.xsd` files, EX-003 flagged normal
`process.env.X_KEY` reads. | Always run new detection rules against a REAL representative
corpus before trusting precision — synthetic fixtures encode the author's own assumptions.
Fix: EX-002 → secret-FILE-paths only, dropped EX-003, UNI-001 skips a leading BOM, DC-001
(relative rm -rf) → medium. "Pattern present" ≠ "malicious"; documentation legitimately
names secrets and uses dangerous commands.

2026-08-25 | Fresh-context reviewer found the doc-context FP was WIDER than the first pass:
regex rules fire inside quoted/example/comment text (prettier-ignore comments, "detects
jailbreak attempts", "print the instructions", "follow these instructions exactly"), biasing
the flagship "% carry injection" number up and mis-grading defensive/security skills. Also:
gunzip had no maxOutputLength (decompression-bomb DoS), and sanitizeEvidence missed 6
non-Cf invisible codepoints UNI-004 flags. | Tighten each over-broad rule to require an
actionable/possessive target; add a "documents attacks defensively" fixture (injection-docs
→ 0 findings) so the FN/FP boundary is a committed test. Bound decompression BEFORE parsing
(gunzip maxOutputLength), not after (the per-file caps run post-inflate). Sanitizer must escape
every codepoint the rules flag as invisible, including Lo/Mn/So — test by codepoint, not a char
class (combining marks trip no-misleading-character-class).
