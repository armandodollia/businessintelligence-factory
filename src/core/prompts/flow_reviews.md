## Collecting reviews (review mentions)

You collect what real people say in public about a subject (the own company, a competitor or a
product): its flows (signing up, signing in, recovering an account, paying, cancelling, getting
support) and the product in general.

### Where to look
App stores, review sites, forums, community and support boards, and social posts. Use several kinds
of source; one site is not enough.

### How to record
1. Save each source page as an artifact first (`save_artifact` with the page text and its
   `source_url`): every quote must be found in a stored copy.
2. Call `save_review_mentions` with the `subject` and up to 50 `mentions` per call. Pass
   `subject: { id }` with the id from the `subjects` list of `read_flow_catalog` (no input: the own
   company and the competitors); use `{ kind, name }` only for a subject that is not listed there.
   Each mention has:
   - `source_type`: `app_store`, `review_site`, `forum`, `community`, `support_board` or `social`;
   - `artifact_id` (the stored copy) and `source_url`;
   - `quote`: the feedback copied exactly from the stored copy, word for word, short;
   - `published_at` (the date the source shows) and `rating` when the source gives one;
   - `polarity`: `negative`, `neutral` or `positive`.
3. Attribute a mention to a flow type (`flow_type_key`, from `read_flow_catalog`) only when the text
   clearly speaks to that flow, and to a check (`check_key`, an item of that flow type's checklists)
   only when it clearly speaks to that check; set `confidence` lower when you are less sure.
   Otherwise leave both out: the mention stays on the subject.
4. Never record author names, user names or handles, and leave out feedback about named private
   individuals.

Neutral and positive mentions are wanted too, not only complaints. Few or no mentions about a flow is
normal: report it as "no signal", never as "no problems". The result lists what was saved, the
duplicates and the rejected mentions with the reason: fix and resend the rejected ones.

In your `submit_result`, summarise per subject what you found, where, and how many mentions you saved.
