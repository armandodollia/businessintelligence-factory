# The feedback bundle

A feedback bundle is one file that says how the tool worked on one machine: runs, failures, review
rounds, costs, the lesson signals, and the tester's own ratings and decisions. A tester makes it on
the "Send feedback" page and sends it by their own means. The application sends nothing and writes
the file only where the tester saves it.

This page is for two readers: the tester who makes a bundle, and the person who reads bundles.

## Making a bundle (the tester)

1. Open "Send feedback" in the header (the address ends in `#/feedback`).
2. Choose the period. Leave both dates empty for everything.
3. Choose what the file includes:
   - **Standard** (the default): numbers, labels, ids, timings, versions, and your own feedback
     (ratings, accept and reject decisions, corrections) with the reasons you typed. Nothing of what
     the research found. A failure is written as its class and the first line of its message. A web
     address in any text, your own reasons and note among them, is written `<url>`.
   - **With review texts**: also the text of review issues and council findings, failure messages
     in full, and the decision lines of the training export. These texts speak about your research,
     and web addresses in them are kept.
4. Add a note if you want. It is included as you typed it.
5. Press "Preview". The page lists each section with its number of rows and its size. "Show first
   rows" shows the first rows of a section, so you can read what will be in the file.
6. Press "Save". The browser downloads `bif-feedback-<date>-<id>.json.gz`. In the desktop app a
   save dialog asks where to put it.
7. Send the file to the person who asked for it.

The saved file is built when you press "Save", so it has its own id and also holds rows added after
the preview.

### What no bundle holds

At either level:

- uploads, text taken from uploads, and internal stakeholder records;
- stored site passwords;
- the names of your businesses and their parts (their ids are written), and each distinctive word
  of such a name on its own: for a business called "Quillfeather Logistics", "Quillfeather" alone
  is replaced too;
- your user id (you are written as `tester`);
- the folders of your computer (a file path is cut to the file name);
- secrets of the configuration (telemetry headers, the environments of browser servers) and its
  machine paths (the data folder, the browser profile);
- the words of a record whose shape the tool did not choose. Your business profile is such a record
  (the interviewer writes it in its own words), and so is the before / after value of a change you
  made. Of such a record a bundle holds the numbers and the tool's own labels, under keys that say
  nothing: a key that is not one plain word of letters, digits and underscores, or that holds a
  name, is written `key_1`, `key_2`, … An edit of the profile carries nothing of the profile at
  all: only which of its sections changed (`section`) and how many values each held before and
  after (`leavesBefore`, `leavesAfter`);
- why research of your own stakeholders failed, while that research is withheld in the app (it is
  still running, or its business has a stakeholder you have not opened). Such a run, task,
  experiment or research run says that it failed and nothing more, and the metrics count the
  failure under its class alone.

A reason you typed on a record that is itself internal or derived from an upload is left out, and
the row says `reasonWithheld: true`.

The names, your user id, stored passwords and folders are removed from the keys of every section as
well as from the values.

### Limits to know

The removal of paths and names works on text, so it has limits:

- A path with spaces that is not quoted and is not under the data folder, the browser profile, your
  home folder or the temporary folder loses the home folder but keeps what follows its first space.
  This holds for a Windows path too (`C:\Work Files\notes.txt` under no known folder keeps
  `Files\notes.txt`). It is an accepted limit.
- A relative path is left as it is.
- A business name shorter than four characters is replaced only as a whole word in its own case.
- A common word of a name is not replaced on its own. "Logistics", "Group", "Delivery" or "North"
  stay where they stand alone, and so does a word shorter than four characters. The list of common
  words is in `src/core/feedbackBundle/commonWords.ts`: everyday English and the words many
  business names share. A word the tool itself writes (its labels, the names of its phases and of
  its own things, such as "pipeline") or a word of the name of a configured model or provider is
  left alone too, so that a business named with one damages no figure.
- A business whose name is one of the tool's own words ("Opus", "Synthesis", "Tester") is not
  replaced by that word alone; its other words and its full multi-word name still are.
- A name, and a distinctive word of a name, is replaced as a whole word, in any case. Inside a
  longer word of a text it is not ("Quillfeathers"), and not where an underscore joins it to
  another word (`quillfeather_share`): that is how the tool writes its own ids and labels, which no
  name may change. In the key of a record whose shape the tool did not choose it counts also inside
  a longer word (`quillfeatherShare` is written `key_1`).
- The names of competitors are replaced by their ids in a standard file, whole and by their
  distinctive words, like the names of your businesses. At the fuller level they are kept, because
  the review texts speak about them.
- The names of stakeholders and personas are not names the removal knows. No part of a standard
  file copies them, but a reason or note you typed keeps them as typed.
- A web address is recognised by its start (`http://`, `https://`, `ws://`, `wss://`, `ftp://` or
  `www.`). A bare host name without one (`shop.example`) is left as it is, at either level.
- A key that is one plain word and holds no name, and no distinctive word of one, is kept, whatever
  the word is. In a record of the
  tool's own shape that is a field name; in your profile it is a word the interviewer chose.
- A field name of the file is one plain word, and a name or a word of one inside a longer one is
  not replaced there: a business unit called "Duration" leaves `durationMs` as it is. When a field name is exactly a
  business name, a user id or a stored password, it is replaced like any other text, and a reader
  of the file no longer finds that field.

Read the preview before you save if your reasons or note could hold such text.

## Reading bundles (the owner)

```
npm run feedback:report -- <bundle files or folders> [--out report.md]
```

- A folder is read with every `*.json.gz` in it and below it. The same bundle given twice is read
  once.
- The report is Markdown. It goes to the standard output, or to the file named by `--out`.
- A file that is not a bundle, or whose format version this reader does not know, is refused: the
  report and the error output name it with the reason, the other files are still read, and the exit
  code is 1. The exit code is also 1 when no bundle was read.

The report has:

1. **Versions and platforms**: one row per bundle with the app version, the database schema
   version, the platform, the Node version, the agent CLIs, the level, the period and the number of
   business trees.
2. **Combined**: every bundle together.
3. **Tester `<id>`**: one part per bundle, with the tester's note first.

The combined part and each tester part show the same figures: runs and failures by class, pass rate
and rounds to pass, cost and tokens by role and by model, the most frequent lesson-signal
categories, rating agreement, the council and persona panel figures, and the requests to the person
with how long they waited. A request that "Stop research" closed is counted in its own column
("Closed by a stop"), not as denied, and its wait is left out of the median.

A tester is one bundle. Two bundles from the same person count as two testers, so ask each tester
for one bundle that covers the whole period.

## The file

Gzip-compressed JSON: `{ id, manifest, sections }`.

- `manifest`: the format version (`format`, now `1`), the bundle id, when it was made, the app
  version, the database schema version, the platform and architecture, the Node version, the agent
  CLIs with their versions where the setup check read them, the period, the level, the note, and
  the row count of each section.
- `sections`: one entry per section. Each section is a list of blocks, one per business tree, and a
  block never holds a row of another tree. `configuration` is the effective configuration without
  secrets and machine paths. `texts` exists only at the fuller level: the texts of review issues and
  council findings, the decision lines of the training export, and in `failures` the whole message
  of every failure a standard section carries as its first line (kinds `run`, `attempt`, `task`,
  `research_run`, `experiment`, `retro`, `persona_learning_run`). A failure of withheld research, or
  of something the training export leaves out, is named there by its id with `withheld: true`.

The sections are `configuration`, `trees`, `runs`, `tasks`, `reviewRounds`, `outcomes`,
`lessonSignals`, `lessons`, `feedback`, `policy`, `knowledge`, `metrics`, `audits`, `personas`,
`escalations`, `budgets`, `requests` and `texts`. Each comes from the query the tool itself uses for
its retro, its lessons and its metrics page.

A row of `requests` has the stored `status`. A request that "Stop research" closed is stored as
`denied`; its row also says `closedBy: 'stop'`, because the person denied nothing.

What `runs` does not have: the effort, the request kind and the idle time of a run. The store does
not keep them per run.

The period bounds every table whose rows have a time, by that time; the recurrence of review issues
counts the issues made within it. Not limited by the period: the counts per tree, the lesson rules,
the outcomes report table, the budget status and the open count of the user-persona gate. They
describe the state when the bundle was made. A row inside the period keeps its own totals whole (a
task its number of runs, a recommendation its panel reactions, an escalation its re-runs).

## Routes

- `POST /api/feedback-bundle/preview`: body `level` (`standard` or `with_texts`), `since`, `until`
  (a day `YYYY-MM-DD` or an ISO time), `note`, and `rows: { section, limit }` for the first rows of
  one section. Answers the sections with their rows and sizes.
- `POST /api/feedback-bundle`: the same body without `rows`. Answers the file.

Both build the bundle in memory. Neither writes a file on the server or sends anything.
