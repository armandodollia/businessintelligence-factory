# Known limitations

- **OpenCode is unverified end to end.** No live OpenCode run has succeeded yet. See
  [smoke-results.md](smoke-results.md).
- **OpenCode rate limits can hang a run until `limits.idleTimeoutMs`.** On the free tier OpenCode
  retries 429s internally without printing anything to stdout (stderr output is not guaranteed). So
  the idle watchdog ends the run (default 10 minutes), the run is marked failed (not rate-limit
  retried) and the task's one retry applies. Rate-limit text that OpenCode does print on stderr is
  detected, but it does not shorten the hang. Lower `idleTimeoutMs` if you use OpenCode's free tier.
- **Offline runs need a provider that can run offline.** Codex refuses offline runs. So reads by own
  stakeholders and former colleagues, learning runs for those personas, the run that combines a
  former colleague's two layers and the user persona's learning run go to Claude or OpenCode. With
  neither enabled they are skipped and a harness decision records why (see
  [stakeholders.md](stakeholders.md)); the server also warns at start-up. Own-stakeholder research
  itself is not offline and runs on any provider.
- **Claude runs inherit your global Claude Code hooks and plugins**; isolating them breaks OAuth (see
  [setup.md](setup.md#agent-cli-isolation)).
- **Config changes** to worker and browser limits and the port need a restart. (`BIF_DATA_DIR` and
  `PORT` overrides are runtime-only and are not written into `bif.config.json` when you save
  settings.)
- **Rate-limit back-off holds the worker slot** while waiting (up to 15 minutes per wait; base 30
  seconds, at most 6 attempts).
- **A council round that failed because a member was unavailable is not a review.** Re-running the
  task from its escalation redoes the work; it does not only review the existing result again (see
  [council.md](council.md#when-a-member-is-unavailable)).
- **"What changed" only compares screenshots that findings or confirmations cite.**
- **User, scheduler and calibration decisions** are stored as orchestrator decisions with
  `payload.actor` telling them apart. User decisions (weight changes, prompt patch approvals and
  calibration reverts) record your `user.id` as the run id. Approvals and reverts also record the
  role's resulting prompt version (worker / synthesizer: the base worker prompt without task-type
  extras; persona: the persona calibration appendix).
- **Local only, no authentication.** Any other program on your machine can still call the API. What
  the server does refuse is in [privacy-and-export.md](privacy-and-export.md#local-only-server).
- **Hiding is not isolation on disk.** An agent with shell access can read files under the data
  directory (see [stakeholders.md](stakeholders.md#isolation)).
- **Export paraphrase gap.** Uncited text paraphrased from an upload-exposed output and carried on two
  tasks later is not caught (see [privacy-and-export.md](privacy-and-export.md#export-and-uploads)).

Review-gate history and open items per section:
[superpowers/verify-log.md](superpowers/verify-log.md).
