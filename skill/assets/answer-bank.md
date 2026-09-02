# Answer Bank — free-text application answers

> ⚠️ **NOT YET APPROVED (drafted 2026-09-02).** Felix reviews this file once; until
> the banner is removed, appliers may use it only alongside the same honesty rules
> that already govern `felix-resume.md`. After approval it becomes the default
> source for every free-text box.

**Rules for appliers**
- **Assembly, never authorship.** Pick the closest answer, then you may *reorder,
  trim to the word limit, drop a paragraph, and fill the marked `[[SLOT]]`* from
  the JD. You may **not** add a fact, metric, technology, date, motivation, or
  scope that is not already in this file or `application-profile.json`.
- Every `[[SLOT]]` must be filled from the posting itself (team, product, stack
  named in the JD). If the JD gives nothing to fill it with, delete the sentence.
- If a question is not covered here and `felix-resume.md` does not hold the
  material either, **park** the posting and record the exact question text.
- Word limits: cut from the end of a paragraph, keep the first sentence.
- Numbers that must never appear: see `application-profile.json → constraints.forbidden_numbers`.

Sources: vault `wiki/felix-resume.md`, `wiki/application-essay-response-bank.md`
(SpaceX essay, 2026-08), `wiki/jpmorgan-behavioral-answers.md` (recorded takes,
2026-08-05), the Stoke Space essay submitted 2026-09-01, and `resume.tex`.

**Confirmed facts (Felix, 2026-09-02) — usable in any answer, verbatim or lightly rephrased.**
These appear in `resume.tex` but not in `felix-resume.md`; the first draft of this bank
kept them out as unsourced. Felix confirmed all three are real:
- the six messaging-channel integrations are "used by 400+ users on deployed agents";
- they support "30% of total human-agent IM channel connections" (OpenMax);
- "JWKS-validated Entra ID auth spanning four sovereign Azure clouds for eight components on the agent's registry".
Still six channels, not seven (Telegram excluded) — that guardrail stands.

---

## A. Why this company / why this role — template

**Covers:** "Why <company>?", "Why do you want to work here?", "What interests you
about this role/team?", "Why are you a good fit?"

I build infrastructure for AI agents: this summer at OpenMax I shipped six production
messaging-channel integrations against one channel-conformance contract, a hybrid
BM25 + dense-embedding retrieval pipeline fused by Reciprocal Rank Fusion and
reranked by a cross-encoder, and a Dockerized evaluation harness that scores an
agent's long-term memory. Every one of those handled input I did not control or
quality I could not eyeball, so I learned to design the measurement before tuning
the system and to test the failure path, not just the happy path. [[SLOT: one
sentence naming the team/product/problem from the JD and which of the above it
maps to — e.g. "Your <team> works on <X>, which is the same class of problem as
<retrieval / channel gateway / eval harness>."]] I want to spend the summer on a
team that ships to real users and reviews code seriously, because that is where
the OpenMax work taught me the most.

*Sources:* felix-resume.md Experience (six channels, conformance contract, zylos-recall
RRF/cross-encoder, mem-eval); essay-bank closing line ("punished approximation").

---

## B. Hardest technical problem — short form

**Covers:** "Hardest thing you've done", "Most challenging technical problem",
"A time you debugged something difficult", "Describe a technical accomplishment".

The hardest was diagnosing mem-eval, a LongMemEval-based harness I built at OpenMax to
measure how well an agent's memory survives months of conversation. The harness itself
was nontrivial: a Dockerized distill → answer → judge pipeline, 125 questions, graded by a
judge rather than exact-string match, replaying one memory-sync per simulated day
because a single whole-history pass inflates the score. It reported roughly 75%
retention overall, but one category, single-session preferences, scored 3 of 15. The
easy move was to log it as a known weakness. Instead I first re-checked the replay
methodology, since a bad benchmark produces a bad number as easily as a bad system, then
traced the loss stage by stage. The failure was not at answer-time retrieval, where
everyone looks first, but two stages upstream in distillation, where those preferences
were being summarized away before they became durable memories. I documented it with a
worked example in the README. What I learned: a benchmark number is only useful if you
keep asking why, and the stage you'd naturally blame is often not the one at fault.

*Sources:* Stoke Space essay (2026-09-01), felix-resume.md mem-eval entry (34 commits,
75% baseline, 3/15 category, upstream-distillation finding).

### B-long. Hardest technical problem — full essay (~800 words, submitted to Stoke Space 2026-09-01)

Use verbatim when a form asks for a 500–1000-word essay on the same prompt.

The hardest thing I've done was leading the diagnostic work on mem-eval, a LongMemEval-based benchmark harness I built to measure how well an AI agent's memory system holds up over long conversation histories -- while also being the person responsible, in practice, for making sure a mediocre benchmark number didn't just get accepted as "good enough."

I joined OpenMax's engineering team in Shenzhen, China, in person, for a summer software engineering internship. mem-eval became my largest single effort there: 34 commits, more than on any other project I touched. The harness is a Dockerized distill-answer-judge pipeline that runs 125 long-term-memory questions against the system and measures whether it correctly recalls facts and preferences from far back in a conversation history. Getting the pipeline itself built and reliable was already nontrivial -- three stages that all have to agree on data formats, running inside Docker so results are reproducible run to run, evaluated against a graded judge rather than exact-string matching.

But building the harness wasn't the hard part. The hard part came after: the benchmark reported roughly 75% retention overall, and one specific category -- single-session preferences, things a user mentions once and expects the agent to remember -- scored only 3 out of 15, about 20%. It would have been easy to write that number down, note it as a known weakness, and move on to the next feature. Instead I made a decision that this specific failure needed a real explanation, not just a score.

I went back through the harness's replay methodology first, because a bad benchmark can produce a bad number just as easily as a bad system can. The harness replays one Memory Sync per haystack day -- a deliberate choice, because letting it do a single whole-history pass at answer time would have inflated the score by giving the system more context than it would realistically have in production. That design was sound, so the low score wasn't an artifact of the test; it reflected something real. I then had to trace the failure through the actual pipeline stages -- distill, then answer -- to find where the information was actually being lost. It turned out the problem wasn't at answer time, when the system searches for relevant memories to use, but earlier, at distillation time, when raw conversation gets compressed into stored memories in the first place. Single-session preferences were getting summarized away or deprioritized before they ever became a durable memory the retrieval step could find later. I documented this with a worked example in the project's README so the finding wouldn't just live in my head.

What I learned from this, concretely, is that a benchmark number is only useful if you're willing to keep asking "why" after you get it, and that root-causing a failure often means being suspicious of the stage you'd naturally blame first. My instinct, and I think most people's instinct, would have been to assume the retrieval step was underperforming, since that's the part that's visible at answer time and the part most people build eval harnesses to test. Retrieval wasn't the problem. The problem was two stages upstream, in a part of the pipeline nobody was watching as closely because it doesn't produce an obvious pass/fail signal on its own.

The other thing I took from this experience was less technical: doing this diagnostic work while working in-person in Shenzhen, in a role where I also had to explain architecture decisions to the team in Chinese, meant I couldn't just write a message with a screenshot and move on. I had to be precise enough about the mechanism -- distillation, not retrieval -- to explain it clearly in a second language to people who hadn't run the benchmark themselves. That constraint made me a more careful communicator about my own technical findings than I think I would have become otherwise, because vague explanations don't survive translation.

I carried the same instinct into other work that summer: on a RAG memory-retrieval system I built, I didn't stop at shipping hybrid search with reranking, but added an offline evaluation harness with golden cases so future regressions would be caught automatically, gated on measured numbers rather than a general sense that retrieval "seemed fine." The underlying habit is the one mem-eval taught me: don't stop at the first plausible explanation, or at a single aggregate number, when a more specific answer is still available if you keep digging.

I still think of mem-eval as the project where I learned the difference between measuring something and understanding it. Anyone can run a benchmark and report a percentage. The harder and more valuable skill is refusing to stop at the percentage when it doesn't yet explain itself -- and being able to explain, precisely, what you found instead.

---

## C. Project deep-dive — pick the variant by role

**Covers:** "Describe a project you're proud of", "Tell us about a technical project",
"Hands-on technical project and your role", "Most highly technical accomplishment".

**Selection rule:** AI/ML, platform, or backend role → C1. Systems, embedded, compiler,
performance, avionics, or C/C++-heavy role → C2. Data science, analytics, or
time-series role → C3. If unsure, C1.

### C1 — Retrieval system + its evaluation (AI/ML, backend, platform)

An agent carrying months of history has to answer from it without re-reading it. I built
the hybrid retriever at OpenMax: BM25 and dense embeddings fused by Reciprocal Rank Fusion
over ranks rather than scores, because BM25 is unbounded and cosine is not, so summing
them needs a calibration that breaks the moment the corpus shifts; a cross-encoder rerank
capped by passage count; and a one-second fail-open timeout so retrieval never blocks a
turn. The part I would defend hardest is the measurement. I built an offline evaluation
harness with an 18-case graded golden set before tuning anything, and it runs as a
regression gate at nDCG@k 0.95 and injected-F1 0.85, exiting non-zero below baseline.
Separately, the LongMemEval harness I built showed a 75% retention baseline with the
weakest category at 20%, which I traced to upstream distillation rather than answer-time
retrieval. The fix was not in the component I had built.

*Sources:* SpaceX essay slot 1; felix-resume.md zylos-recall (28 commits / 20 PRs, RRF,
cross-encoder, fail-open 1s, eval/baseline.json gates) and mem-eval entries.

### C2 — Systems programming in C (systems, embedded, performance)

In CMU's 18-213 I wrote a 64-bit memory allocator: segregated explicit free lists,
footerless allocated blocks, two-word mini-blocks, and better-fit search (best-fit within
the first viable size class, first-fit beyond), reaching 11,031 KOPS at 74.1%
utilization. Footerless blocks are what actually buy the utilization; the trade is that
coalescing has to read the previous block's allocation bit out of the header. I also
wrote a multithreaded HTTP proxy with detached thread-per-connection handling and a
mutex-guarded LRU object cache, heap-allocating each connection's descriptor to close the
classic accept-loop race; the cache copies objects out while holding the lock so the
caller never sees a dangling pointer. I know its weaknesses too: a single global cache
mutex rather than a reader/writer lock, and a dedup scan that releases the lock before
insert, so two threads can insert the same URL. Naming those is part of understanding the
design.

*Sources:* felix-resume.md Systems Programming / "Memory Allocator vs Network Proxy"
section (verified from FelixLin6/18-213); 11,031 KOPS / 74.1% confirmed by Felix
2026-08-04. Never link the code (academic integrity).

### C3 — Water-leak forecasting, time-series ML (data science, analytics)

SmartMeter is a latch-on water-meter system I co-authored and published at MLNLP '22
(ACM). A Cloud Vision dial reader supplies readings from an unmodified analog meter, and
a seasonal ARIMA forecaster learns the household's daily water-use rhythm from 15-minute
readings: ADF stationarity test, a 96-step daily seasonal period, SARIMAX(2,0,1)(1,0,1,96)
fitted with pmdarima's auto_arima and statsmodels. I validated a held-out one-day forecast
by RMSE against a seasonal-naive baseline, with a non-seasonal ARIMA(4,0,4) notebook as
the ablation showing why the seasonal term is needed. Consumption that diverges from its
own forecast flags a candidate leak. The honest limits: the dataset is about a week of
sparse readings and the notebooks are a proof of concept, so the paper's evaluation is
qualitative and I claim no accuracy number.

*Sources:* felix-resume.md Water Leak Detection entry and Source Lookaside row; resume.tex
bullet. The "~10% reduction" figure is fabricated and must never be used.

---

## D. What motivates you / what excites you about your next internship

**Covers:** "What motivates you?", "What are you most excited to work on?", "What do
you look for in a job / team?"

What motivates me is work where the result can be measured and the measurement can be
trusted. The memory allocator I wrote hit 11,031 KOPS at 74.1% utilization, and the
number told me exactly which side of the throughput-versus-utilization trade I had
optimized. The retrieval pipeline I built at OpenMax is gated on a graded golden set
rather than on whether search "seemed fine." When the memory benchmark I built reported a
20% category, the interesting part was not the score but tracing it two stages upstream
to distillation. I look for a team that ships to real users, reviews code seriously, and
treats a surprising number as something to explain rather than record. [[SLOT: one
sentence on what in the JD's description of the work fits that — e.g. the team's
system, scale, or measurement problem.]]

*Sources:* Stoke Space "What motivates you?" answer (2026-09-01), felix-resume.md
allocator / zylos-recall / mem-eval facts; behavioral-interview-prep "what I look for in a
job" (ownership, shipped end to end).

---

## E. Career goals / where you see yourself

**Covers:** "Long-term career goals", "Where do you see yourself in 3–5 years", "How
does this internship fit your goals?"

> ⚠️ Felix to confirm the direction: the vault records the goal as complicated
> (an AI/robotics research track is live alongside AI-infrastructure SWE). This draft
> states the SWE version only, from work he has actually done.

I want to build the infrastructure that AI agents run on: the memory, retrieval,
evaluation, and communication layers that decide whether an agent is reliable in
production. That is the work I did at OpenMax, contributing to Zylos, an open-source
agent-infrastructure platform, across roughly 200 commits: the six-channel messaging
gateway, the hybrid retrieval pipeline, and the LongMemEval evaluation harness. Over the
next few years I want to go deeper on the systems side of that: performance, concurrency,
and measurement, building on the 18-213 allocator and proxy work and the parallel
algorithms and generative-AI coursework I am taking now. An internship on a team that
ships production software with real users is the most direct way to get there. [[SLOT:
optional sentence tying the company's product to that path.]]

*Sources:* felix-resume.md Experience (~207 commits across 11 repos, Zylos description),
cmu-coursework-record.md (Fall 2026: 10-723, 15-210), behavioral-interview-prep note on
the open research pivot.

---

## F. Teamwork / leadership / handling competing priorities

**Covers:** "Describe a leadership experience", "A time you worked on a team", "Managing
competing priorities", "Leadership principle you identify with", "A time you showed
humility / owned a mistake".

> No formal leadership title is documented (vault: "CMU Buggy is a checkbox, not a
> role"). Do not invent one. Use the team-and-ownership evidence below.

At OpenMax in early June 2026 I was carrying two things at once: client-driven demands for
messaging-channel capabilities on the agent product, and the memory-evaluation research I
was also responsible for. I set an explicit rule, client-facing work first, shipped the
core channel functionality on time, and kept the research moving rather than dropping it;
that research became the mem-eval harness. Every channel component then went through the
team's production-readiness review, which is where I learned the security and
resource-lifecycle bar for shipping, and I presented architecture plans to the team in
Chinese for review. On humility: when I describe my own HTTP proxy I name its real
weaknesses, an unbounded header buffer, a cache dedup race, a single global mutex, because
knowing where your design fails is part of owning it.

*Sources:* jpmorgan-behavioral-answers.md Q2 (dated, real incident), felix-resume.md
Experience (production-readiness review, bilingual docs, Chinese presentations), Network
Proxy weaknesses list; Blue Origin "Practice Humility" answer (2026-09-01).

---

## G. What you learned outside the classroom / workplace

**Covers:** "What have you learned outside of school or work?", "Tell us something not
on your résumé", "How do you learn new things?"

Two things from the summer in Shenzhen. First, working in a second language changed how I
explain technical findings: presenting architecture plans to the team in Chinese meant a
vague explanation did not survive translation, so I learned to state the mechanism
precisely, distillation, not retrieval, before anyone asked. Second, working fast with AI
tools taught me a specific warning sign: when an explanation comes back full of vocabulary
I do not know, that is not a vocabulary problem, it is a signal that I have dropped out of
the loop and can no longer judge whether the output is correct. I built a small tool that
forces every explanation to start from introductory definitions and build up, and my rate
of actually learning from the AI, rather than just accepting it, went up.

*Sources:* Stoke Space "learned outside the classroom" answer; jpmorgan-behavioral-answers.md
Q3 (both takes, the "AI out of the loop" insight, the Claude Code skill).

---

## H. Additional information / anything else we should know

**Covers:** "Anything else you'd like us to know?", "Additional information",
"Comments".

I am a US citizen (no sponsorship needed, ITAR-eligible), a junior at Carnegie Mellon's
School of Computer Science in the B.S. Artificial Intelligence program, expected May 2028,
available full time and in person for Summer 2027 and open to any US location. I
co-authored a published paper at MLNLP '22 (ACM) on computer-vision water metering with
ARIMA forecasting, and earned USACO Silver in 2020. My portfolio is at felixlin.dev and
code at github.com/FelixLin6.

*Sources:* application-profile.json (work authorization, education, availability,
location policy), awards/publications.

---

## Coverage map (question → section)

| Form question pattern | Use |
|---|---|
| Why us / why this role / good fit | A |
| Hardest problem / challenge / debugging / accomplishment | B (B-long for ≥500-word essays) |
| Describe a project / your role / technical deep-dive | C1 / C2 / C3 by role |
| Motivation / what excites you / what you look for | D |
| Career goals / 3–5 years / fit with goals | E (Felix to confirm direction) |
| Leadership / teamwork / priorities / humility / ownership | F |
| Learned outside class / not on résumé / how you learn | G |
| Additional info / anything else | H |
| Salary, availability, relocation, EEO, auth | `application-profile.json`, not prose |
| Anything not above | park, record the exact question |
