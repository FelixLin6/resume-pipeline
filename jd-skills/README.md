# jd-skills

Accumulate `{role, category, skills[]}` datapoints from job descriptions — the skill
chips Simplify scrapes, or any other source — and read the distribution per role type.

Run it as `jd-skills` (symlinked into `~/.local/bin`) or
`node ~/zylos/vault/jd-skills/jd-skills.js`.

## Adding a posting

```
jd-skills add --role "Software Engineer Intern" \
  --role-clean "Backend Software Engineer Intern" \
  --company Datadog --category swe \
  --keywords "Python, React, SQL, Git"
```

`--role-clean` is required (Felix, 2026-08-25): posting titles are marketing, so
every record carries a second label saying what the role *really* is, judged from
the JD's responsibilities — not its title. Example: Verkada's "Security Software
Engineer Intern" is backend distributed systems work at a security-products
company → `roleClean: "Backend Software Engineer Intern"`. If the title is
already accurate, repeat it verbatim.

Keep `roleClean` to a small vocabulary so distributions group cleanly:
`<Domain> Software Engineer <Level>` with domains like Backend, Frontend,
Full-Stack, Infrastructure, ML, Data, Mobile, Embedded — and Security only when
the work is actual security engineering (appsec, threat modeling, crypto).

Or paste the chip list on stdin, which is usually faster — comma- or newline-separated
both work, and bullet prefixes are stripped:

```
jd-skills add --role "ML Engineer Intern" --company Scale --category mle <<'END'
Python
PyTorch
Distributed Systems
END
```

Optional: `--level intern|new-grad|...`, `--url <posting>`, `--source <where>`,
`--force` (override the duplicate guard).

`--category` is free text — pick a small vocabulary and stay consistent
(`swe`, `mle`, `ds`, `quant`, `infra`). Consistency is what makes `compare` work.

## Reading it

```
jd-skills list [--category swe] [--limit 20]
jd-skills stats [--category mle] [--top 25]
jd-skills compare mle swe [--top 15] [--min-count 2]
jd-skills export --format csv > skills.csv
```

`stats` gives raw frequency per category. `compare` gives **lift** — how much more
often a skill shows up in one category than the other. Lift is the useful number:
raw frequency is dominated by skills every posting lists (Python, communication,
Git), which tell you nothing about what separates an MLE posting from an SWE one.

## Data model

`data.jsonl`, append-only, one JSON object per line:

```json
{"role":"...","roleClean":"...","company":"...","category":"mle","level":null,
 "url":null,"source":"simplify","added":"2026-08-25",
 "raw":["PyTorch","React.js"],"skills":["pytorch","react"]}
```

`role` is the verbatim posting title and is never rewritten; `roleClean` is the
judged label described above.

**`raw` is never rewritten.** `skills` is derived from it through `aliases.json`
(lowercase, trim, alias map). So when you inevitably decide that `React.js` and
`React` should collapse — or shouldn't — edit `aliases.json` and run:

```
jd-skills renormalize
```

which replays the map over the untouched raw column. Normalization decisions stay
reversible; that's the whole reason both columns exist.

## Reading the numbers honestly

- Below ~5 postings in a category the distribution is anecdote, not data. Both
  `stats` and `compare` warn about this.
- Simplify's chips are **Simplify's extraction**, not the JD itself. Whatever their
  parser over- or under-weights is baked into every row here. Fine for relative
  comparison across postings; not a claim about what employers wrote.
- A skill's frequency measures what postings *say*, which is not what interviews
  *test*. Treat it as vocabulary intelligence, not a study plan.
