# Privacy and export

What stays on your machine, what leaves it, and what the training export leaves out. Stakeholder
data has its own rules on top of these: see [stakeholders.md](stakeholders.md#export).

Code: `src/core/scoring/export.ts`, `src/core/internal/`, `src/api/routes.ts`.

## What leaves the machine

- Agent runs send their prompts and the content they read to the model provider of their CLI.
- Two-pass OCR sends scans and images to the model provider through your Claude CLI, unless you turn
  it off (see [knowledge-store.md](knowledge-store.md#scans-and-images-two-pass-ocr)).
- With `telemetry.otlp.enabled`, bus events (ids, types and statuses only) go to your OTLP endpoint.
- Research agents browse the web on the research profile (see [setup.md](setup.md#research-browser-profile)).

Uploads appear in prompts as metadata only (id, type, size, date). Agents read upload text only
through the knowledge read tools, and every such read is logged.

## Export and uploads

The JSONL export (`GET /api/workspaces/:id/export`) leaves out by default, unless
`?includeUploads=1`:

- everything that cites an internal upload or anything the knowledge store marks upload-derived (a
  fact confirmed with an upload, a later version of such a fact, a record citing one;
  `explainUploadDerived` says why);
- every judgment of an **upload-exposed run**, that is a run that was *shown* upload-derived text by
  a read tool or its prompt, even if it cited none;
- the **task of such a run**: its reviews, deliverable decisions and outputs;
- later judgments that **cite one of those outputs**, treated like an upload: by id, through a record
  that cites it (a recommendation's findings), or because their task's outputs cite it (then all of
  that task's judgments go, as when a task's outputs cite an upload). So if a synthesis task saves a
  recommendation citing a fact from an exposed task, its judgments, persona feedback on that
  recommendation and your ratings of either are left out.

Only citing excludes. A later run that is only shown one of those outputs is not exposed by that,
its reads are exported, and a judgment citing only that task's other outputs is exported. Exposure is
computed at each export from the retrieval log and never stored, so it cannot spread through cards
or briefings.

Each export reports what it left out, counted by cause: cites an upload, exposed run, task of an
exposed run, references an output of such a task. The report comes in the `x-bif-export-summary`
header and from `GET /api/workspaces/:id/export/summary`. The Decision log (like the Metrics page)
computes it only when you press its button, because that runs the whole export, and shows it with an
"including uploads" link.

Known limit: uncited text paraphrased from such an output and carried on two tasks later is not
caught.

What the export contains is listed with each subsystem: [learning.md](learning.md#feedback-log)
(feedback, requests, interview transcript, review status), [knowledge-store.md](knowledge-store.md#knowledge-tracking)
(retrieval events, fact observations), [persona-panel.md](persona-panel.md#what-you-see) (baseline
lines), [flows.md](flows.md#your-reactions-with-reasons) (persona verdicts are never exported), and
[learning.md](learning.md#experiments) (experiment and audit tags).

## Local-only server

There is no authentication. The server binds to `127.0.0.1` only and:

- rejects requests whose `Host` is not `127.0.0.1` / `localhost` (DNS rebinding);
- requires JSON (or multipart uploads) on state-changing requests;
- refuses non-local `Origin`s.

Artifacts are served with `Content-Security-Policy: sandbox` and `nosniff`; HTML and SVG snapshots
download instead of rendering. PDFs (filings) are the exception to the sandbox: browsers refuse to
show a sandboxed PDF, so they open inline with `nosniff` only.

Any other program on your machine can still call the API (see
[known-limitations.md](known-limitations.md)).
