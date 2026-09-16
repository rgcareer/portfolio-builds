# CS Prompt Field Kit

A curated, teardown-annotated prompt library for Customer Success and onboarding
teams. Not a dump of 200 prompts: a focused set of cards for the jobs CS actually
does, each one shipped with the judgment that makes a prompt safe to hand a
teammate.

Built as a static Astro site. No account, no tracking, no backend.

## What makes a card

Most prompt libraries hand you a template and wish you luck. Every card here
carries five parts, and the build fails if any one of them is missing:

1. **Template:** a fill-in-the-blank prompt with the variables marked.
2. **Worked example:** a realistic scenario with the blanks filled in.
3. **Good vs bad teardown:** a strong output next to a *plausibly* bad one, with
   the failure modes annotated (hallucinated specifics, wrong register, buried
   lede, and so on).
4. **Guardrails:** when NOT to use it, the responsible-use flags, and whether a
   human has to review the output before it reaches a customer.
5. **Model notes:** the recommended model, temperature, and settings.

The five-part contract is enforced twice: as required fields in the Astro content
schema (`src/content.config.ts`), and again at the file level by
`scripts/check-cards.mjs`, which runs automatically before every build.

## How the library is organised

Cards are tagged by **job to be done** (renewal prep, QBR prep, escalation, save
play, churn post-mortem, and more) and by **lifecycle stage** (onboard, adopt,
renew, expand, rescue). The homepage lets you search and filter by stage; every
card is copy-to-clipboard and print-friendly.

## Run it locally

Requires Node 22.12 or newer.

```sh
npm install
npm run dev       # local dev server
npm run check     # verify every card has all five elements
npm run build     # production build to ./dist (runs the card check first)
npm run preview   # preview the production build
```

`npm run build` fails loudly if a card is missing an element or the card count
falls below the 16-card floor. That is intentional: the gate is the point.

## Rolling it out to a team

Collecting prompts is easy; getting a team to use them is the hard part. The
`/rollout` page is a five-rung adoption ladder for exactly that, the lite cut of a
longer CS adoption playbook.

## Authoring a new card

Add a Markdown file under `src/content/cards/`. Copy the frontmatter shape from an
existing card, keep all five parts, and make the bad example *plausibly* bad, the
way a real team would actually misuse the prompt, not a strawman. Run
`npm run check` before committing.

## Credits

A Get Smart AI publication. Authored by Ryan.

## License

MIT. Use the prompts, adapt the cards, roll them out.
