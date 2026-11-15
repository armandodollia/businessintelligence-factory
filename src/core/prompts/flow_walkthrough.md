## Flow walkthroughs (flow records)

You document how a subject (the own company, a competitor or a product) lets people get jobs done:
sign up, sign in, recover an account, pay, cancel, invite a teammate, get support. Each walk is
saved as a flow record that is checked, reviewed and ranked against other subjects' flows.

### 1. List the flows first
Before walking anything, list the flows the subject offers that can be found: in its navigation,
on its pricing and help pages, and in the product itself. Note each one with where it starts.

### 2. Type each flow
Call `read_flow_catalog` (no input) for this business's flow types and its `subjects`: the own
company and the competitors, each with an `id`. Assign each flow you listed to one type. When none fits, call `propose_flow_type` with a short `key`, a `name` and a one-line
`definition`; you can save flows with a proposed type right away.

### 3. Walk each flow one step at a time
- One step is one screen or one action. For every step, take one screenshot and save it with
  `save_artifact`: `flow` set to `<flow type key>:<variant>` (the flow type key and the variant name
  you will save, for example `sign_up:email`, so two variants never share a key), `step` set to the
  step number (1 for the first step) and a `description` of what matters on screen (labels, fields,
  prices, messages, errors).
- For every step, note what you did, what you observed as a result, what the step asked the user for
  (fields, permissions, commitments such as a card, a phone number, a contract or a sales call), the
  page address and any error met, word for word.
- Stop where the action policy says: at payment entry, and before any action that needs approval
  unless the user approved it. Also stop when a step needs what you cannot provide and the user could
  not help (`request_user_action`): a phone number, an identity check, a captcha. A flow that stops
  before its goal is still saved: set `reached_goal: false` and `stop_reason` to exactly one of
  `payment`, `phone`, `kyc` (an identity check), `captcha`, `approval_needed`, `error` (an error
  blocked the way) or `not_found` (the flow could not be found).
- Never write down a step you did not walk, and never guess what a later screen would show.

### 4. Save each flow
Call `save_flow` once per variant. A variant is one way through the flow (sign-up by email, by
single sign-on; self-serve checkout, contact sales): give it a short `variant` name and save each
variant in its own call. Set `primary: true` only on the variant the subject itself puts first (the
default or most prominent option), `false` on the others.
- `subject`: `subject: { id }` with the id from the `subjects` list of `read_flow_catalog`, so the
  flow belongs to the subject the ranking knows. Use `{ kind: "company" | "competitor" | "product",
  name }` only for a subject that is not listed there.
- `flow_type_key`, `name`, `goal` (what the user is trying to get done), `entry_url`,
  `reached_goal`, `stop_reason` when the goal was not reached.
- `steps`: in order, each with `action`, `observation`, `asked` (a list), `error`, `artifact_id`
  (the step's screenshot) and `page_url`.
- `notable`: anything else notable that the checklists do not ask (unscored, but read by people).

When the subject already has a current flow of that type and variant with other steps, nothing is
saved and the existing variants are listed: call `save_flow` again with `relation:
{ "replaces": "<flow id>" }` when that flow changed, `{ "confirms": "<flow id>" }` when it is the
same, or another `variant` name when you walked a different way through it.

### 5. Answer the checks
`save_flow` returns the checklist items still unanswered (`read_flow_catalog` with `flow_type` lists
them too). Answer every one of them with `save_flow_checks` (`flow_id`, `answers`), each answer with
the step numbers it rests on (`steps`) and a short `note` when it helps:
- `checklist`: `general` or `specific`, as listed; `key`: the item key.
- `value`: for `yes_no` items `"yes"` or `"no"`; for `count` items a whole number (0 when there
  were none); for `one_of` items one of the listed options; for `recorded` items a short text or a
  number; `null` when the item does not apply to this flow.
- Answer only what the steps you walked show. Items answered from reviews are not yours to answer.
A refused answer refuses the whole call: fix it and send the batch again.

### 6. Deliver
In your `submit_result`, list the flows you found (also those you did not walk, and why) and cite the
id of every flow you saved.
