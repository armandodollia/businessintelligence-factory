/**
 * The built-in flow type catalog (design §8.1) and checklists (design Appendix A.1–A.5) as data.
 * `ensureCatalog` (`./catalog.ts`) seeds them, active, into every business tree once.
 *
 * Mapping of Appendix A: "Good = yes" → `yes_no` passing on yes; "none" → `count` passing at 0;
 * "no reports" → `yes_no` phrased so that yes is the good answer, answered from reviews (R) or
 * both (B); "recorded" → `recorded`, not scored. All weights 1.
 */
import type { CheckAnsweredBy, ChecklistItem } from './types.js';

export const BUILTIN_FLOW_TYPES: ReadonlyArray<{ key: string; name: string; definition: string }> = [
  { key: 'sign_up', name: 'Sign-up', definition: 'Create a new account.' },
  { key: 'sign_in', name: 'Sign-in', definition: 'Get into an existing account.' },
  { key: 'account_recovery', name: 'Account recovery', definition: 'Get back into an account after losing a password or sign-in method.' },
  { key: 'onboarding', name: 'Onboarding to first use', definition: 'Go from a new account to the first real use of the product.' },
  { key: 'pricing', name: 'Pricing and plan choice', definition: 'Find out what it costs and choose a plan.' },
  { key: 'checkout', name: 'Checkout', definition: 'Pay for a plan or a purchase.' },
  { key: 'cancel_or_downgrade', name: 'Cancel or downgrade', definition: 'Cancel a subscription or move to a cheaper plan.' },
  { key: 'invite_teammate', name: 'Invite a teammate', definition: 'Bring another person into a shared account or workspace.' },
  { key: 'get_support', name: 'Get support', definition: 'Get help with a problem from the company.' },
];

const W: CheckAnsweredBy = 'walkthrough';
const R: CheckAnsweredBy = 'reviews';
const B: CheckAnsweredBy = 'both';

/** Objective check passing on "yes". */
const yes = (key: string, question: string, answeredBy: CheckAnsweredBy = W): ChecklistItem => ({
  key, question, kind: 'yes_no', pass: { answer: 'yes' }, weight: 1, scored: true, answeredBy,
});
/** Objective count check passing at zero. */
const none = (key: string, question: string, answeredBy: CheckAnsweredBy = W): ChecklistItem => ({
  key, question, kind: 'count', pass: { max: 0 }, weight: 1, scored: true, answeredBy,
});
/** Audience-dependent fact: recorded and given to the personas, not scored. */
const recorded = (key: string, question: string, answeredBy: CheckAnsweredBy = W): ChecklistItem => ({
  key, question, kind: 'recorded', weight: 1, scored: false, answeredBy,
});

export const BUILTIN_CHECKLISTS: ReadonlyArray<{ flowTypeKey?: string; coverage: number; items: ChecklistItem[] }> = [
  // A.1 General (every flow)
  {
    coverage: 0.3,
    items: [
      yes('goal_reached_without_help', 'Goal reached without leaving the product for help'),
      none('dead_ends', 'Dead ends (a screen with no way forward)'),
      yes('errors_explain_fix', 'Errors met name the problem and how to fix it'),
      yes('input_survives_error', 'Input survives an error (nothing typed is lost)'),
      yes('asks_only_what_next_step_needs', 'Asked only for what the next step needs'),
      none('deceptive_patterns', 'Deceptive patterns (pre-ticked consent, hidden decline, forced extras, disguised ads)'),
      yes('next_step_stated', 'Each screen says what happens next'),
      yes('progress_survives_leaving', 'Progress survives leaving and coming back', B),
      yes('keyboard_with_visible_focus', 'Works by keyboard alone, with visible focus'),
      yes('works_at_phone_width', 'Works at phone width without sideways scrolling'),
      yes('works_for_real_users', 'The flow works for real users (no reports that it fails or breaks)', R),
      recorded('steps_and_fields_to_goal', 'Number of steps and fields to reach the goal'),
      recorded('commitment_before_value', 'Commitment asked before any value (card, phone, contract, sales call)'),
      recorded('tone_and_explanation', 'Tone and amount of explanation'),
    ],
  },
  // A.2 Sign-up
  {
    flowTypeKey: 'sign_up',
    coverage: 0.6,
    items: [
      yes('value_before_account', 'Value can be seen or tried before an account is required'),
      yes('password_rules_shown_early', 'Password rules shown before or while typing, not after a failed submit'),
      yes('no_forced_character_rules', 'No forced character-type rules; long passwords and paste allowed'),
      yes('password_can_be_shown', 'Password can be shown while typing'),
      yes('fields_checked_on_leave', 'Fields are checked when left, with specific messages'),
      yes('verification_does_not_block', 'Email or phone verification does not block first use, or can be finished later'),
      yes('verification_arrives_and_works', 'The verification code or link arrives and works (no reports that it does not)', B),
      yes('code_entry_paste_autofill_resend', 'Code entry accepts paste and autofill; resend offered'),
      yes('consents_separate_unticked', 'Consents are separate and unticked'),
      yes('no_puzzle_without_alternative', 'No puzzle or text-copying test without an alternative'),
      recorded('sign_up_options', 'Sign-up options offered (email, single sign-on, social, passkey)'),
      recorded('card_phone_or_sales_call_to_start', 'Card, phone or sales call required to start'),
      recorded('profile_questions_before_use', 'Profile questions asked before first use'),
    ],
  },
  // A.3 Sign-in
  {
    flowTypeKey: 'sign_in',
    coverage: 0.7,
    items: [
      yes('separate_from_sign_up', 'Sign-in is clearly separate from creating an account'),
      yes('password_managers_and_paste', 'Password managers and paste work'),
      yes('password_can_be_shown', 'Password can be shown while typing'),
      yes('wrong_sign_in_guides_safely', 'A wrong sign-in says what to do next without revealing which part was wrong'),
      yes('last_method_remembered', 'The method used last time is remembered or hinted'),
      yes('second_factor_has_fallback', 'A second factor, when asked, has a fallback'),
      yes('no_memory_test_or_puzzle', 'No memory test (pick the 3rd and 5th characters) or text-copying puzzle without an alternative'),
      yes('sign_in_reliable', 'People can sign in reliably: codes arrive, no loops (no reports that they cannot)', R),
      yes('sessions_hold', 'Sessions hold; people are not signed out unexpectedly (no reports that they are)', R),
      yes('lockout_recoverable_self_serve', 'Lockout after failed attempts is recoverable without contacting support', B),
      recorded('sign_in_options', 'Sign-in options offered (password, single sign-on, passkey, magic link)'),
      recorded('second_factor_frequency', 'How often a second factor is asked for', B),
      recorded('session_length', 'Session length before re-sign-in', B),
    ],
  },
  // A.4 Account recovery
  {
    flowTypeKey: 'account_recovery',
    coverage: 0.6,
    items: [
      yes('start_from_sign_in', 'Recovery can be started from the sign-in screen'),
      yes('does_not_reveal_account', 'The response does not reveal whether an account exists'),
      yes('reset_message_arrives_and_works', 'The reset message arrives and its link or code works (no reports that it does not)', B),
      yes('new_password_one_step_same_rules', 'A new password is set in one step, under the same rules as sign-up'),
      yes('no_security_questions', 'No security questions'),
      yes('signed_in_or_sent_to_sign_in', 'After reset, the user is signed in or sent straight to sign-in'),
      recorded('recovery_without_original_contact', 'Recovery without access to the original email or phone'),
    ],
  },
  // A.5 Checkout (walkthroughs stop before paying, so checks that need a completed payment are
  // answered from reviews only)
  {
    flowTypeKey: 'checkout',
    coverage: 0.6,
    items: [
      yes('purchase_without_account_first', 'Purchase possible without creating an account, or the account is created after paying'),
      yes('full_price_before_payment_details', 'Full price, taxes and fees shown before payment details are asked'),
      yes('billing_and_renewal_terms_stated', 'Billing period and renewal terms stated before paying'),
      yes('nothing_added_unchosen', 'Nothing added to the order that the user did not choose'),
      yes('order_reviewable_before_paying', 'Order can be reviewed and edited before paying'),
      yes('payment_errors_explain_and_keep_input', 'Payment errors say what to fix and keep what was entered'),
      yes('charges_match_shown', 'Charges match what was shown (no reports of surprise charges)', R),
      recorded('payment_methods', 'Payment methods offered'),
      recorded('trial_terms', 'Trial terms: card needed, length, what happens at the end'),
      recorded('upsells_before_paying', 'Upsells shown before paying'),
    ],
  },
];
