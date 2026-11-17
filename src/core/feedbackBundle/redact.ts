/**
 * Redaction of the feedback bundle (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §3.2).
 *
 * Two kinds of rule live here:
 *
 * - What a section may copy from a record (`figures`, `labelOrNumber`, `idOrText`, `shortReason`,
 *   `testerActor`, `redactConfiguration`): a section never copies a stored record; it names the fields
 *   it takes, and passes anything free-form through these.
 * - What is applied to the whole bundle last (`redactBundle`), so that no section can forget it:
 *   stored site passwords (the existing `redactSecrets`, over the identities of every workspace), file
 *   paths cut to their last segment, business and node names replaced by their ids, every person
 *   written as `tester`, and at the standard level every web address written `<url>`. The rules apply
 *   to the keys of every section as well as to the values (`Redaction.key`).
 *
 * Keys. A record whose shape is not the tool's (`figures`) keeps a key only when it is a plain
 * identifier that no rule flags; any other key becomes `key_1`, `key_2`, … In the whole-bundle pass a
 * key that is a plain identifier is, outside `texts`, replaced by a name only when the whole key is
 * that name: the field names of the bundle are such identifiers, and a business unit called
 * "Research" must not turn `researchRunId` into something no reader knows.
 *
 * Names. The names the rules know are those of the businesses and their nodes, of their competitors, and the scope names of
 * the nodes (`workspaces`). A whole name is replaced by the node's id, as a whole word in any case; so
 * is each distinctive word of a name on its own (`distinctiveWords`: four characters or more, not a
 * common word of `commonWords.ts`, not a word of the tool: `TOOL_WORDS`, `configuredModelNames`). In the
 * key of a free-form record such a word counts also inside a longer identifier (`zephyrineShare`): the
 * key is flagged (`Redaction.flags`) or, in `texts`, the word in it replaced. Names of
 * stakeholders and personas are research content, which no standard section copies; the name rules do
 * not know them.
 *
 * A name rule changes no figure the tool wrote: no id, label, phase, task type, tool or event name,
 * model or provider name, not `tester`, no placeholder. Three things see to it. A letter, a digit or
 * `_` on either side of a match means "inside a longer word or identifier", so nothing matches inside
 * `arun_01…` or `phase_skipped`. A string that is an id as a whole (`isIdShaped`) is not given to the
 * name rules. And a name that is one of the tool's own words (`ownWordTest`) has no rule of its own.
 *
 * Limits, stated so nobody relies on more: a common word of a name ("Logistics", "Group") is not
 * replaced on its own, nor is a distinctive one inside a longer word of a text or joined to another
 * word by `_` (`quillfeather_share`); a business whose name is one of the tool's own words ("Opus",
 * "Synthesis", "Tester") is not replaced by that word alone, its other words and its full name of
 * several words still are; a name shorter than four characters is replaced only as a
 * whole word in its own case (replacing `Sol` inside `gpt-6.1-sol` would damage the figures); a path
 * with spaces is cut whole when it is quoted (Node quotes the paths in its own errors) or lies under a
 * folder the tool knows (the data folder, the browser profile, the home and temp folders:
 * `machineFolders`), otherwise up to its first space, which still removes the home folder; relative
 * paths are left as they are.
 */
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { LENSES, PROVIDER_IDS, ROLES, TASK_TYPES, type BifConfig } from '../config/schema.js';
import { ESCALATION_SKIPPED_ACTOR } from '../escalation/escalation.js';
import { USER_ACTIONS } from '../feedback/actions.js';
import { DEFAULT_ACTOR, FEEDBACK_KINDS, actorOf } from '../feedback/events.js';
import { SIGNAL_SCALES } from '../feedback/signals.js';
import { ROUND_ACTOR } from '../flows/round.js';
import { ISSUE_ACTIONS, ISSUE_CLASSES, TOOL_NAMES } from '../harness/tools/registry.js';
import { KNOWLEDGE_SIGNAL_KINDS } from '../knowledge/metrics.js';
import { LESSON_ACTIONS, LESSON_PROPOSAL_STATUSES, LESSON_RULE_STATUSES } from '../learning/lessons/types.js';
import { SYSTEM_ACTOR } from '../learning/outcomes.js';
import { SCHEDULER_ACTOR } from '../learning/reviewerAudit.js';
import { OUTCOME_LABELS, OUTCOME_SOURCES, REVIEW_ISSUE_STATUSES } from '../learning/types.js';
import { PANEL_ACTOR } from '../market/panel.js';
import { LEARNING_ACTOR } from '../personas/learn.js';
import { POLICY_EVENT_KINDS } from '../policy/policyEvents.js';
import { PHASE_TASK_TYPES } from '../research/phases.js';
import { CRITERIA } from '../scoring/criteria.js';
import { COMBINE_ACTOR } from '../stakeholders/combine.js';
import { READS_ACTOR } from '../stakeholders/reads.js';
import type { Store } from '../store/db.js';
import { REDACTED, redactSecrets } from '../store/redact.js';
import { PERSISTED_BUS_EVENT_TYPES } from '../telemetry/busEvents.js';
import { USER_LEARNING_ACTOR } from '../userPersona/learn.js';
import { COMMON_WORDS } from './commonWords.js';

/** How the person who used the tool is written in a bundle. */
export const TESTER = 'tester';

/** What stands where a value was text and not a figure or a label. */
export const TEXT_PLACEHOLDER = '[text]';

/** Longest failure reason of the standard level (the full message is in `texts` at the fuller level). */
export const SHORT_REASON_CHARS = 200;

// ---------------------------------------------------------------------------
// what a section may copy

/** Actors that are parts of the tool, not people: written as they are. */
const SYSTEM_ACTORS: ReadonlySet<string> = new Set([
  SYSTEM_ACTOR, SCHEDULER_ACTOR, LEARNING_ACTOR, COMBINE_ACTOR, READS_ACTOR, USER_LEARNING_ACTOR, ROUND_ACTOR, PANEL_ACTOR, ESCALATION_SKIPPED_ACTOR,
]);

/** `tester` for a person (whatever their id, also when none was recorded); a system actor keeps its name. */
export function testerActor(actor: string | undefined): string {
  return actor !== undefined && SYSTEM_ACTORS.has(actor) ? actor : TESTER;
}

/** Labels the tool itself writes: the values of its enums. A string that is one of these is never research content. */
const LABELS: ReadonlySet<string> = new Set<string>([
  ...ROLES, ...TASK_TYPES, ...PROVIDER_IDS, ...LENSES, ...OUTCOME_LABELS, ...OUTCOME_SOURCES, ...REVIEW_ISSUE_STATUSES, ...FEEDBACK_KINDS,
  ...POLICY_EVENT_KINDS, ...LESSON_ACTIONS, ...LESSON_PROPOSAL_STATUSES, ...LESSON_RULE_STATUSES,
  ...Object.values(SIGNAL_SCALES).flatMap((s) => Object.keys(s)),
  'queued', 'running', 'reviewing', 'waiting_user', 'verified', 'unverified', 'failed', 'pending', 'superseded', 'done', 'skipped', 'interrupted',
  'resolved', 'denied', 'accept', 'reject', 'edit', 'merge', 'agree', 'disagree', 'neutral', 'active', 'retired', 'candidate', 'current', 'replaced',
  'retracted', 'blocking', 'substantive', 'nit', 'scope_expansion', 'company', 'division', 'slice', 'external', 'internal', 'hidden', 'open',
  'segment', 'stakeholder', 'user', 'agent', 'add', 'replace', 'retire', 'keep', 'drop', 'revoke', 'high', 'medium', 'low', 'up', 'flat', 'down',
  '↑', '→', '↓', 'yes', 'no', 'true', 'false', 'unknown', 'api', 'schedule', 'engine', 'retro', 'miss', 'invalid', 'upheld', 'advisory', 'dropped',
  'work', 'review', 'revise', 'fix', 'pushback', 'proposed', 'no_change', 'baseline', 'persona', 'A', 'B',
]);

/** A stored id: `<prefix>_` and 26 characters (`newId`), alone or joined by colons (`<recId>:<personaId>`). */
const ID = /^[a-z]{1,10}_[0-9A-Z]{26}$/;
const isIdLike = (s: string): boolean => s.split(':').every((p) => ID.test(p));
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
/** A number written as a string, with the signs people put around one (`$10k`, `12%`, `1-5`). */
const NUMBER_LIKE = /^[-+]?[$€£]?\d[\d.,]*\s?[%kKmMbB]?(-\d[\d.,]*)?$/;

/** Keys whose value is one of an enum's labels in the records the tool writes (`afterJson.action`, `status`). */
const LABEL_KEYS: ReadonlySet<string> = new Set([
  'action', 'reaction', 'status', 'kind', 'level', 'verdict', 'stance', 'decision', 'lifecycle', 'mode', 'phase', 'type', 'source', 'class',
  'label', 'outcome', 'role', 'scope', 'event', 'tool', 'previousStatus', 'targetType', 'criterion', 'relation', 'state', 'rule', 'standing',
]);
/** The shape of an enum label: one lower-case identifier, short. No dot: `rival-site.example` is a host name, not a label. */
const LABEL_SHAPE = /^[a-z][a-z0-9_:-]{0,39}$/;

const isFigureString = (s: string, key?: string): boolean =>
  LABELS.has(s) || isIdLike(s) || ISO_TIME.test(s) || (key !== undefined && LABEL_KEYS.has(key) && LABEL_SHAPE.test(s));

/** A key that says nothing by its shape: one identifier, as the tool's own field names are. */
const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * The keys of a record whose shape is not the tool's, as the bundle writes them: a key is kept when it
 * is a plain identifier (`PLAIN_KEY`) that `flagged` does not flag; any other key (a phrase, a name, a
 * path) is replaced by `key_1`, `key_2`, … in the order of the record, so the record keeps its figures
 * and loses the words. `flagged`: the whole-bundle rules (`Redaction.flags`).
 */
export function plainKeys(keys: readonly string[], flagged: (key: string) => boolean = () => false): string[] {
  const kept = new Set(keys.filter((k) => PLAIN_KEY.test(k) && !flagged(k)));
  let n = 0;
  return keys.map((k) => {
    if (kept.has(k)) return k;
    let name: string;
    do name = `key_${++n}`;
    while (kept.has(name));
    return name;
  });
}

/**
 * The figures of a free-form JSON value (a feedback event's before / after, an outcome's evidence):
 * numbers, booleans and nulls; of strings only ids, times, the tool's own labels, and a label-shaped
 * value under a key that holds a label. Any other string is dropped with its key (from an array:
 * left out), and a key that is not a plain identifier is replaced (`plainKeys`), so text never leaves
 * through a record whose shape the bundle does not know: not as a value and not as a key.
 */
export function figures(value: unknown, key?: string, flagged?: (key: string) => boolean): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return isFigureString(value, key) ? value : undefined;
  if (Array.isArray(value)) return value.map((v) => figures(v, key, flagged)).filter((v) => v !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value);
    const names = plainKeys(entries.map(([k]) => k), flagged);
    entries.forEach(([k, v], i) => {
      const f = figures(v, k, flagged);
      if (f !== undefined) out[names[i]!] = f;
    });
    return out;
  }
  return undefined;
}

/** How many values a free-form JSON value holds: its leaves, whatever they are. Nothing (`null`, undefined) holds none. */
export function countLeaves(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'object') return 1;
  return Object.values(value).reduce<number>((n, v) => n + countLeaves(v), 0);
}

/** The shape of an id as the tool writes ids: stored ids, composite ids (`<a>:<b>`), a role, a slug-like key. No spaces. */
const ID_SHAPE = /^[A-Za-z0-9_.:-]{1,200}$/;

/** An id as stored; a value in an id's place that is not shaped like one (it has spaces: it is text) is `[text]`. */
export function idOrText(v: string | undefined): string | undefined {
  return v === undefined || ID_SHAPE.test(v) ? v : TEXT_PLACEHOLDER;
}

/** A rated value: a number, one of the tool's labels or a number written as a string; any other string is `[text]`. */
export function labelOrNumber(v: unknown): number | string | boolean | null | undefined {
  if (v === undefined || v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v !== 'string') return TEXT_PLACEHOLDER;
  return LABELS.has(v) || isIdLike(v) || NUMBER_LIKE.test(v.trim()) ? v : TEXT_PLACEHOLDER;
}

// --- paths ------------------------------------------------------------------------------------------

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lastSegment = (path: string): string => path.split(/[\\/]+/).filter(Boolean).at(-1) ?? '';
const separators = (path: string): number => (path.match(/[\\/]+/g) ?? []).length;

/** A quoted absolute path (it may hold spaces): `'/a/b c/d.txt'`, `"C:\a b\c"`. */
const QUOTED_PATH = /(['"`])((?:file:\/\/)?(?:~|[A-Za-z]:)?[\\/][^'"`\n]*)\1/g;
const FILE_URL = /file:\/\/[^\s'"`<>)]+/g;
const WINDOWS_PATH = /(?<![A-Za-z0-9])(?:[A-Za-z]:|\\)\\(?:[^\\\s'"`<>|*?]+\\)*[^\\\s'"`<>|*?]*/g;
/** An absolute or home path of two segments or more, not inside a URL or a `provider/model` key. */
const POSIX_PATH = /(?<![A-Za-z0-9:/.\\_-])(?:~|\.{1,2})?(?:\/[^\s/'"`<>(),;:]+){2,}\/?/g;

/**
 * The folders of this machine the tool knows, longest first: the data folder and the browser profile (as
 * configured and resolved), the home folder and the temp folder. A path under one of them is cut whole,
 * whatever spaces the folder's own name has (the application folder on macOS has two).
 */
export function machineFolders(config: { dataDir?: string; browser?: { profileDir?: string } }): string[] {
  const configured = [config.dataDir, config.browser?.profileDir].filter((p): p is string => !!p);
  const all = [...configured.filter((p) => isAbsolute(p)), ...configured.map((p) => resolve(p)), homedir(), tmpdir()];
  return [...new Set(all.map((p) => p.replace(/[\\/]+$/, '')).filter((p) => separators(p) >= 1 && p.length > 3))].sort((x, y) => y.length - x.length);
}

/**
 * File paths in a text cut to their last segment (`/Users/x/data/run.log` → `run.log`). `folders`: known
 * folders of the machine (`machineFolders`); a path under one is cut first, as one path.
 */
export function cutPaths(text: string, folders: readonly string[] = []): string {
  let out = text.replace(QUOTED_PATH, (all, quote: string, path: string) => (separators(path) >= 2 ? `${quote}${lastSegment(path)}${quote}` : all));
  for (const folder of folders) {
    if (!out.toLowerCase().includes(folder.toLowerCase())) continue;
    out = out.replace(new RegExp(`${escapeRe(folder)}(?:[\\\\/][^\\s'"\`<>|]*)?`, 'gi'), (path) => lastSegment(path));
  }
  return out
    .replace(FILE_URL, (url) => lastSegment(url.slice('file://'.length)))
    .replace(WINDOWS_PATH, (path) => lastSegment(path) || path)
    .replace(POSIX_PATH, (path) => lastSegment(path));
}

/** What stands where a text held a web address, at the standard level. */
export const URL_PLACEHOLDER = '<url>';
/** A web address: one with a scheme, or one that starts with `www.`. A bare host name (`shop.example`) is not recognised. */
const WEB_URL = /\b(?:(?:https?|wss?|ftp):\/\/|www\.)[^\s'"`<>()[\]{}]+/gi;

/** Web addresses in a text written `<url>` (a site under research must not be named by a failure message). Punctuation after one stays. */
export function cutUrls(text: string): string {
  return text.replace(WEB_URL, (url) => `${URL_PLACEHOLDER}${/[.,;:!?]+$/.exec(url)?.[0] ?? ''}`);
}

/**
 * A failure message as the standard level carries it: its first line, at most `max` characters (the
 * full message is in `texts` at the fuller level). Paths in it are cut with the rest of the bundle
 * (`redactBundle`), which knows the machine's folders. Undefined for no message.
 */
export function shortReason(text: string | undefined, max = SHORT_REASON_CHARS): string | undefined {
  const first = text?.split(/\r?\n/).find((l) => l.trim())?.trim();
  if (!first) return undefined;
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

// --- configuration ----------------------------------------------------------------------------------

/**
 * The effective configuration as the bundle writes it: no secrets (`telemetry.otlp.headers` and
 * endpoint, the browser's MCP servers with their environments, the catch-all mail domain), no user id,
 * no `dataDir` or other machine path (the browser profile, the shared browser's command line; a
 * provider's command is cut to its last segment), and no persona slug (pins are counted).
 */
export function redactConfiguration(config: BifConfig): Record<string, unknown> {
  const c = structuredClone(config) as unknown as Record<string, unknown> & BifConfig;
  const out: Record<string, unknown> = { ...c };
  delete out.dataDir;
  delete out.user;
  out.providers = Object.fromEntries(
    Object.entries(c.providers).map(([id, p]) => [id, { enabled: p.enabled, command: lastSegment(p.command) || p.command, models: p.models }]),
  );
  out.browser = { backend: c.browser.backend, mode: c.browser.mode };
  out.identity = { emailProvider: c.identity.emailProvider };
  if (c.telemetry) {
    const { otlp, ...rest } = c.telemetry;
    out.telemetry = { ...rest, ...(otlp ? { otlp: { enabled: otlp.enabled } } : {}) };
  }
  if (c.personaPanel) {
    const { personas, ...rest } = c.personaPanel;
    out.personaPanel = { ...rest, ...(personas ? { pinnedPersonas: Object.keys(personas).length } : {}) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// what is applied to the whole bundle, last

/** The compiled rules of one store and configuration (`redaction`). */
export type Redaction = {
  /** A carried text with every rule applied. */
  text(s: string): string;
  /** A value that is a figure by its place (the manifest, but for the note): every rule but those of the names. */
  figure(s: string): string;
  /**
   * An object key with the rules applied. `freeForm`: the key of a record whose keys are not the
   * bundle's own (`texts`): every rule, as for a text, and a distinctive word of a name is replaced
   * also inside a longer identifier. Otherwise a key that is a plain identifier is replaced by a name
   * only when the whole key is that name (see the module doc).
   */
  key(k: string, freeForm?: boolean): string;
  /**
   * True when a rule would change `s` (it holds a name, a distinctive word of one, a person, a stored
   * password, a path or, at the standard level, a web address), or when a distinctive word of a name is
   * inside a longer identifier in it. For the keys of free-form records (`plainKeys`).
   */
  flags(s: string): boolean;
};

export type RedactionOptions = {
  /** The fuller level keeps web addresses in the texts it carries. Default: they are written `<url>`. */
  keepUrls?: boolean;
  /** The fuller level carries review texts, which name competitors by design. Default: their names are replaced by their ids. */
  keepCompetitorNames?: boolean;
};

/** What the rules read of the configuration: the user id, the machine's folders, and every model and provider it names (`configuredModelNames`). */
export type RedactionConfig = Pick<BifConfig, 'user'> & { dataDir?: string; browser?: { profileDir?: string }; providers?: Record<string, { models?: string[] }> };

/** What a word or an identifier is made of. One of these on either side of a name means the name is inside a longer one: no match. */
const WORD = '[\\p{L}\\p{N}_]';
/** A name or a word of one as a rule matches it: whole, not inside a longer word or identifier (`arun_01…`, `phase_skipped`). */
const whole = (name: string, flags: string): RegExp => new RegExp(`(?<!${WORD})${escapeRe(name)}(?!${WORD})`, flags);
/** A name from this length is replaced in any case, a shorter one only in its own case; a word of a name is replaced on its own from this length. */
const MIN_NAME_CHARS = 4;

/** The words of a string as they are spelled, and (`wordsOf`) lower-cased. */
const spelledWordsOf = (s: string): string[] => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const wordsOf = (s: string): string[] => spelledWordsOf(s.toLowerCase());

/**
 * Labels the tool writes that no constant defines (a union type, or a literal where the row is made):
 * its own things, the kinds of a request, of a run and of a bundle, the classes of a failure, the
 * states of a council member, the sources and the parts of a lesson signal's category, what a budget
 * request came to. A label of a row that is missing here is found by the test of the seeded rows
 * (`ownWords.test.ts`).
 */
const OWN_TERMS = [
  'workspace', 'pipeline', 'bundle', 'manifest', 'experiment', 'audit', 'harness', 'register', 'login', 'captcha', 'approval', 'normal', 'council_member', 'standard',
  'with_texts', 'rate_limited', 'timeout', 'budget', 'spawn', 'interrupted', 'aborted', 'error', 'reviewed', 'no_score', 'unavailable', 'not_waited', 'review_issue',
  'outcome', 'failure', 'policy', 'feedback', 'rating', 'knowledge', 'recorded', 'other', 'exclude', 'missed_issue', 'extended', 'site', 'total',
];

/**
 * What the tool itself writes into a bundle as a figure, beside `LABELS`: its phases (`mapping` among
 * them), the names of its tools, of its events and of the actions it records, the classes of a review
 * issue and what is done about one, what is rated and by which criterion, the kinds of a knowledge
 * signal, the actors that are parts of it, the keys under which it writes a label, its own things,
 * and what it puts in a redacted place.
 */
const OWN_LABELS: readonly string[] = [
  ...LABELS, ...Object.keys(PHASE_TASK_TYPES), ...TOOL_NAMES, ...ISSUE_CLASSES, ...ISSUE_ACTIONS, ...USER_ACTIONS, ...PERSISTED_BUS_EVENT_TYPES,
  ...Object.keys(CRITERIA), ...Object.values(CRITERIA).flatMap((defs) => defs.map((d) => d.key)), ...KNOWLEDGE_SIGNAL_KINDS, ...SYSTEM_ACTORS, ...LABEL_KEYS, ...OWN_TERMS,
  TESTER, TEXT_PLACEHOLDER, URL_PLACEHOLDER, REDACTED,
];

/** The words of the tool, lower-cased: every word of what it writes as a figure (`OWN_LABELS`). A name rule replaces none of them. */
const TOOL_WORDS: ReadonlySet<string> = new Set(OWN_LABELS.flatMap(wordsOf));

/**
 * The model and provider names of a configuration: every `model` and `provider` it holds (of a role,
 * a seat, an audit), every model listed for a provider, and the provider ids.
 */
function configuredModelNames(config: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === 'string') {
      if (key === 'model' || key === 'provider' || key === 'models') out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (key === 'providers') out.push(k);
        walk(x, k);
      }
    }
  };
  walk(config);
  return out;
}

/**
 * The words of a stored name that are replaced on their own, lower-cased: four characters or more, with
 * a letter (a year is no name), not a common word (`COMMON_WORDS`), and not one of `toolWords` (the
 * tool's own words: replacing "news" would damage `news_scan`).
 */
export function distinctiveWords(name: string, toolWords: ReadonlySet<string> = TOOL_WORDS): string[] {
  return [...new Set(wordsOf(name))].filter((w) => w.length >= MIN_NAME_CHARS && /\p{L}/u.test(w) && !COMMON_WORDS.has(w) && !toolWords.has(w));
}

/**
 * Whether a stored name is one of the tool's own words: written without a space, and made of the
 * words of `ownLabels` alone ("Opus", "Synthesis", "Tester", `submit_result`, `weak-review`). Such a
 * name has no rule: replacing it would replace the figure. A name of several words is not one ("Deep
 * Dives" as typed is in no figure) and is replaced whole. A name is compared as its rule matches: in
 * any case, or (a short name) in its own case, so "Sol" is not the `sol` of `gpt-6.1-sol`.
 */
function ownWordTest(ownLabels: readonly string[]): (name: string) => boolean {
  const anyCase = new Set(ownLabels.flatMap(wordsOf));
  const asSpelled = new Set(ownLabels.flatMap(spelledWordsOf));
  return (name) => {
    const words = name.length >= MIN_NAME_CHARS ? wordsOf(name) : spelledWordsOf(name);
    const own = name.length >= MIN_NAME_CHARS ? anyCase : asSpelled;
    return !/\s/u.test(name) && words.length > 0 && words.every((w) => own.has(w));
  };
}

/** A part of a composite id that is no stored id: the lower-case label before one (`cnl`, `budget`, `workspace`). */
const ID_LABEL = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * Whether a string is an id as a whole: a stored id (`newId`: `<prefix>_` and 26 characters), or
 * stored ids and lower-case labels joined by colons with a stored id among them: a council round
 * (`cnl:<task>:<round>`), a reaction (`<recommendation>:<persona>`), a budget (`budget:workspace:<node>`).
 */
function isIdShaped(s: string): boolean {
  const parts = s.split(':');
  return parts.some((p) => ID.test(p)) && parts.every((p) => ID.test(p) || ID_LABEL.test(p));
}

/** Every person in the store: who rated, acted, answered, proposed, audited or experimented. */
function people(store: Store, config: Pick<BifConfig, 'user'>): string[] {
  const ids = new Set<string>([DEFAULT_ACTOR, actorOf(config)]);
  // Every table that records who acted (found by its `actor` column, so a table added later is covered).
  const tables = store.db
    .prepare(`SELECT m.name AS t FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'actor' WHERE m.type = 'table'`)
    .all() as Array<{ t: string }>;
  for (const { t } of tables) {
    for (const r of store.db.prepare(`SELECT DISTINCT actor AS a FROM "${t}" WHERE actor IS NOT NULL`).all() as Array<{ a: unknown }>) {
      if (typeof r.a === 'string') ids.add(r.a);
    }
  }
  // The user persona is kept under the person's id.
  for (const r of store.db.prepare(`SELECT DISTINCT subject_id AS a FROM personas WHERE kind = 'user' AND subject_id IS NOT NULL`).all() as Array<{ a: string }>) ids.add(r.a);
  return [...ids].map((a) => a.trim()).filter((a) => a && !SYSTEM_ACTORS.has(a) && !LABELS.has(a) && a !== TESTER);
}

/** The rules of `store` and `config`, compiled once for a bundle. */
export function redaction(deps: { store: Store; config: RedactionConfig }, opts: RedactionOptions = {}): Redaction {
  const { store, config } = deps;
  const folders = machineFolders(config);
  // Stored site passwords of every workspace, through the existing redaction.
  const allIdentities = { identities: { list: () => store.identities.list() } };
  // Lower-cased name → its stored spelling and the node's id; the first node with a name keeps it.
  const names = new Map<string, { spelled: string; id: string }>();
  for (const w of store.workspaces.list()) {
    for (const n of [w.name, w.scope?.name]) {
      const spelled = n?.trim();
      if (spelled && !names.has(spelled.toLowerCase())) names.set(spelled.toLowerCase(), { spelled, id: w.id });
    }
  }
  // Competitors are businesses under research: their names are replaced by their ids as well, so a
  // reason the tester typed cannot carry one (a business or node name wins when both spell the same).
  for (const w of opts.keepCompetitorNames ? [] : store.workspaces.list()) {
    for (const c of store.competitors.list({ workspaceId: w.id })) {
      const spelled = c.name?.trim();
      if (spelled && !names.has(spelled.toLowerCase())) names.set(spelled.toLowerCase(), { spelled, id: c.id });
    }
  }
  const models = configuredModelNames(config);
  const toolWords = new Set([...TOOL_WORDS, ...models.flatMap(wordsOf)]);
  // A name that is one of the tool's own words has no rule: not as a text, not as a key.
  const isOwnWord = ownWordTest([...OWN_LABELS, ...models]);
  for (const [lower, { spelled }] of [...names]) if (isOwnWord(spelled)) names.delete(lower);
  const nameRules = [...names.values()]
    .sort((a, b) => b.spelled.length - a.spelled.length)
    .map(({ spelled, id }) => ({ re: whole(spelled, spelled.length >= MIN_NAME_CHARS ? 'giu' : 'gu'), id }));
  // Each distinctive word of a name, on its own: the first node whose name has the word keeps it.
  const words = new Map<string, string>();
  for (const { spelled, id } of names.values()) {
    for (const w of distinctiveWords(spelled, toolWords)) if (!words.has(w)) words.set(w, id);
  }
  const longestFirst = [...words.keys()].sort((a, b) => b.length - a.length);
  const wordRules = longestFirst.map((w) => ({ re: whole(w, 'giu'), id: words.get(w)! }));
  /** A distinctive word anywhere in a string, also inside a longer identifier. */
  const wordInside = longestFirst.length ? new RegExp(longestFirst.map(escapeRe).join('|'), 'iu') : undefined;
  const personRules = people(store, config)
    .sort((a, b) => b.length - a.length)
    .map((p) => new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(p)}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'giu'));
  const apply = (s: string, named: boolean): string => {
    // One of the tool's own labels says nothing about a business or a person, whatever they are called.
    if (LABELS.has(s)) return s;
    let out = redactSecrets(allIdentities, '', s);
    // Before the paths: the path of a web address is not a file path.
    if (!opts.keepUrls) out = cutUrls(out);
    out = cutPaths(out, folders);
    // An id says nothing about a business, whatever a business is called (`budget:workspace:<node>`).
    if (isIdShaped(out)) return out;
    if (named) {
      for (const r of nameRules) out = out.replace(r.re, r.id);
      for (const r of wordRules) out = out.replace(r.re, r.id);
    }
    for (const re of personRules) out = out.replace(re, TESTER);
    return out;
  };
  const text = (s: string): string => apply(s, true);
  return {
    text,
    figure: (s: string): string => apply(s, false),
    key(k: string, freeForm = false): string {
      // A free-form key: every rule, and a distinctive word of a name also inside a longer identifier.
      if (freeForm) return wordInside ? text(k).replace(new RegExp(wordInside.source, 'giu'), (w) => words.get(w.toLowerCase()) ?? w) : text(k);
      if (!PLAIN_KEY.test(k)) return text(k);
      if (LABELS.has(k)) return k;
      // A plain identifier: a path or a web address it is not. A name only as the whole key.
      const named = names.get(k.toLowerCase());
      if (named && (named.spelled.length >= MIN_NAME_CHARS || named.spelled === k)) return named.id;
      let out = redactSecrets(allIdentities, '', k);
      for (const re of personRules) out = out.replace(re, TESTER);
      return out;
    },
    flags: (s: string): boolean => text(s) !== s || (wordInside?.test(s) ?? false),
  };
}

/**
 * `value` with every string in it redacted, object keys too (`keys: 'own'`, the default: the keys are
 * field names, `Redaction.key`; `'free'`: the keys of free-form records, redacted as texts are;
 * `'keep'`: keys are left as they are). Two keys that become the same keep both values: the later
 * one gets `_2`, `_3`, …
 */
export function redactValue<T>(r: Redaction, value: T, keys: 'own' | 'free' | 'keep' = 'own'): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return r.text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const base = keys === 'keep' ? k : r.key(k, keys === 'free');
        let name = base;
        for (let n = 2; Object.hasOwn(out, name); n++) name = `${base}_${n}`;
        out[name] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * The bundle with the whole-bundle rules applied (see module doc): the one call `buildBundle` makes
 * last. In every section the keys are redacted as well as the values; `texts` holds free-form records,
 * whose keys are redacted as texts are. The keys of the manifest are the fixed names `buildBundle`
 * writes (a reader finds the format version by one of them) and stay; of its values only the note is
 * the tester's words, and the others are searched for no name (`Redaction.figure`: the platform is
 * `darwin` whatever a business is called). `r`: the rules, when the caller compiled them already;
 * else they are compiled here, with web addresses written `<url>`.
 */
export function redactBundle<B extends { manifest: Record<string, unknown>; sections: Record<string, unknown> }>(
  deps: { store: Store; config: RedactionConfig },
  bundle: B,
  r: Redaction = redaction(deps),
): B {
  const figuresOnly: Redaction = { ...r, text: r.figure };
  return {
    ...bundle,
    manifest: Object.fromEntries(Object.entries(bundle.manifest).map(([k, v]) => [k, redactValue(k === 'note' ? r : figuresOnly, v, 'keep')])),
    sections: Object.fromEntries(Object.entries(bundle.sections).map(([name, s]) => [name, redactValue(r, s, name === 'texts' ? 'free' : 'own')])),
  };
}
