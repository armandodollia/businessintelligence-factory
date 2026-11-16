# Evidence and the knowledge store

Every finding rests on stored evidence, and every fact has a history. The knowledge store holds the
evidence text, the facts and their versions, the entities they are about, and the tools agents use
to read it all.

Code: `src/core/evidence/`, `src/core/knowledge/`. Settings:
[configuration.md](configuration.md#knowledge). Design:
[superpowers/specs/2026-11-13-knowledge-store-design.md](superpowers/specs/2026-11-13-knowledge-store-design.md).

## Evidence rule

Every finding cites at least one stored artifact of its business: screenshots per flow step,
archived pages, documents or uploads.

- A confirmation or retraction cites an artifact its own task saved (see [Living facts](#living-facts)).
- A quote in `evidence_refs` must occur in the artifact's text.
- Screenshots need a description (see [Evidence text](#evidence-text)).
- Recommendations cite only usable findings (the current, verified or included version; a replaced,
  retracted or excluded fact is refused).

So the web app can trace recommendation → findings → artifacts.

## Living facts

A finding is a fact with a stable identity across runs (a lineage of versions). A later run
*confirms* it, *replaces* it with a new version (price $10 → $12) or *retracts* it, instead of saving
a duplicate. Nothing is deleted.

`save_finding` checks the store first:

- an identical current claim about the same entity (see [Entities and relations](#entities-and-relations))
  is confirmed automatically (citing an artifact saved in the task);
- similar current facts of the business tree about that entity are returned without saving, until
  the agent says `relation: "new"`, `{confirms}` or `{replaces}`.

`confirm_finding` / `retract_finding` do the same explicitly. A confirmation or retraction must cite
an artifact the task itself saved with `save_artifact` (every save is recorded, even of bytes already
stored).

These observations apply only when the task is verified. An unverified replacement stays an
"unverified update" until you include it. A new version keeps the entity of the one it replaces.

Quotes in `evidence_refs` are checked against the artifact's text, extracted on the spot if it was
still waiting in the extraction queue. Only the current version of a fact feeds synthesis. The review
queue lists a fact's live version, so a new version is rated again. The reviewer sees the prior
claim, the facts a task confirms or retracts, and the verified quotes.

## Entities and relations

Every finding, competitor, persona, symptom and symptom hypothesis is filed under a named *entity*
of its business tree (company, competitor, product, persona, topic, cause, …), matched by name or
alias. Separate trees never share one. Entity kinds: `company`, `competitor`, `product`, `feature`,
`flow`, `persona`, `segment`, `pain_point`, `symptom`, `cause`, `topic`.

- A finding without an explicit `entity` is filed under the competitor / persona / company entity its
  subject names, else a unit's company name, else a topic.
- `save_artifact` can name an `entity` too (an artifact with a `flow` then links the entity to that
  flow).
- An entity is only created when a record is saved under it, never by a duplicate check or a
  confirmation.
- A near-duplicate name is saved anyway and shows up as a *merge suggestion*. Merging or renaming an
  entity is your action (feedback events `entity_merge` / `entity_rename`) and keeps old names
  resolvable as aliases.
- Typed edges (`competes_with`, `offers`, `has_flow`, `causes`, …) each name the record that asserts
  them and count only while that record is usable.
- An entity name that only uploads mention is treated like upload text (the same export and exposure
  rules), and keeps that status as an alias after a merge.

## Evidence text

Every save of an artifact (and every upload) is recorded as a capture (who, which run and task, URL,
flow step), even when the bytes are identical to an earlier save.

Text is extracted in-process from HTML, PDF, docx, pptx, xlsx, csv, markdown, JSON and text. Small
files are extracted at once, larger ones on a background queue that resumes after a restart. Identity
passwords are redacted, and the text is split into searchable passages. A document with the same
text as an earlier one of the business tree points at it instead of being indexed twice.

Screenshots and images saved by agents need a `description` (at least `knowledge.captions.minChars`,
default 20 characters). Images without one (for example uploads) can be described later with
`describe_artifact`.

## Scans and images: two-pass OCR

1. A PDF page with a usable text layer is settled by rules, with no model call.
2. Pages without one, and images, are read in the background by a small model (Haiku, through your
   Claude CLI, with no tools and no access to anything but the file).

The transcription is appended as passages marked `(ocr)`, so it is searchable and quotable like other
evidence text and keeps the upload flag of its artifact. Each model call is logged with its tokens
and cost (`ocr_runs`, shown in the knowledge metrics).

This sends those files to the model provider. Set `knowledge.ocr.enabled: false` (or `images: "none"`) to keep them local. It runs only when the `claude` provider is enabled.

## Knowledge read tools

| Tool | Returns |
|---|---|
| `search` | facts, document passages, artifacts, entity names, records; full-text ranking, labelled hits with ids, no bodies |
| `get_card` | a card computed from reviewed records for an entity or a node |
| `expand` | one id in detail |
| `read_artifact` | outline, extracted text, image, or the raw text file, paged |
| `list_changes` | new, replaced, retracted and newly stale facts, changed cited pages |
| `read_workspace` | a node's card and counts |

### Scope

A query sees its node, the node's sub-units and what it inherits from its parents; the rest of the
business only with `scope: "tree"`; other businesses never (their ids answer exactly like unknown
ids). A read by id returns the named item from any part of the business, labelled with its source.
What it lists around the item (card facts, relations, neighbours) follows the same node scope unless
`scope: "tree"` is passed.

Nothing inside a business is confidential from another part of it. Node scope is a relevance
default. A node-scoped `search` says how many more matches exist elsewhere in the business (counts
only). Around a symptom or cause entity the `causes` / `addresses` relations of the whole business are
listed, each labelled with the part it comes from.

### Budgets and paging

Every response fits a token budget per role (`knowledge.budgets`, capped by `hardMaxTokens`) and
continues with a `cursor` that never skips anything.

- A text page that ends mid-passage says `cut: true` and the next page continues from that character.
- A list item that does not fit the rest of a page starts the next page. Only one too big for a whole
  page is shortened (`cut: true`, dropped list entries counted in `omitted_entries`) and carries
  `full`: the exact call that returns it whole (its own `expand`, its passage, that line of `get_card`
  / `read_workspace`, or the same request at it with a larger `max_tokens`, which may go up to the
  hard maximum).
- A value larger than the hard maximum is served cut with `too_large` and its size.
- A fact's quotes are items of their own; a node card lists one line per profile key; `expand` of a
  node id returns its card.

`read_artifact` uses the `expand` budget and `list_changes` the `search` budget.

### Who may read what

Evidence text is redacted and served inside `<<<EVIDENCE … >>>` fences as untrusted data. Reviewers
(and escalation agents) can only `expand` / `read_artifact` the ids of their task's review slice.
Synthesizer and interviewer see usable facts only.

Every read, and the store text a prompt carries (logged before the run starts), is recorded in
`retrieval_events`. A run shown upload-derived text counts as upload-exposed (see
[privacy-and-export.md](privacy-and-export.md)).

## Knowledge in prompts and recurring runs

Prompts do not list every finding. Each role gets a fixed-size briefing built from cards
(orchestrator 1 500 tokens, worker 1 500, synthesizer 4 000; `knowledge.budgets`). It leaves items
out by naming their ids, then by counts, and is logged as a read before the run starts.

The orchestrator sees the node card, an entity index, changes since the last run of the schedule and
the facts due for re-check (stale, or reaching their TTL before the schedule's next run). It may give
each task `recheck_fact_ids`, which the worker's prompt shows with their claims. Recurring runs
therefore confirm, replace or retract facts instead of saving them again. At company level the
orchestrator also sees the causal edges that cross parts of the business, from the same rule the
cards use.

Uploads appear in prompts as metadata only (id, type, size, date).

The scheduled "What changed" comes from the run's applied fact changes (new, replaced old → new,
retracted, confirmed count) plus the screenshot comparison, with text matching only for facts saved
as `new` (see [research-pipeline.md](research-pipeline.md#scheduler-and-what-changed)).

## Knowledge tracking

When a run saves something citing ids it was shown by a read, those ids are marked used
(`retrieval_uses`). Hit rate = reads with a used result.

Living facts write decision outcomes once each: `confirmed`, `changed`, `retracted`, `stale`,
`user-rejected`, and `duplicate-saved` (when you merge away a fact the agent saved as `new` after the
duplicate check showed it a match, or retract it as a duplicate of another fact). The scheduled "what
changed" records them once, through one path.

Blocked knowledge reads (outside a reviewer's slice, or another business's ids) are policy events.
The export adds retrieval events and fact observations, under the upload rules.

| Route | Serves |
|---|---|
| `GET /api/workspaces/:id/knowledge/metrics` | store size, freshness, hit and zero-result rates, retrieved / used tokens per role, task type, prompt version and model, share of input tokens that was retrieved knowledge |
| `GET /api/workspaces/:id/knowledge/signals` | learning signals per role |

## Knowledge view

The **Knowledge** tab searches the store as you ("this part of the business" / "whole business"),
lists entities and opens their cards, a fact's history and evidence (shown as plain text, never
rendered), merge suggestions, stale facts, conflicts and unverified updates, and recent changes.
Upload-derived items are marked with why the export leaves them out.

These are your actions (feedback events, actor `user.id`): retracting a fact (optionally as a
duplicate of another fact of the same business), applying an unverified update, changing where a
fact applies, merging or renaming entities and rejecting a suggestion.

### Storage report and pruning

The storage report shows, per part and age, the stored files no record references. Nothing is
removed automatically. Pruning is your explicit action on files you pick, at least
`knowledge.retention.pruneMinAgeDays` (default 90) days old.

- It is refused as a whole if any file is still cited (by any fact version, observation, record, the
  latest capture of a flow step, an upload list).
- It removes only the file: the description and extracted text stay, and capturing the same bytes
  again restores it.
