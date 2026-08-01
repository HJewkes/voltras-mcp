// Content data for `coaching.explain` (VW-136/VW-137).
//
// Every entry's `allTiers` string states tier-specific values INLINE rather
// than as a caveat, per the corpus's own framing rule: "an unqualified number
// in this knowledge base is meaningless." A caller that never passes `tier`
// still gets a complete, safe answer. `perTier` is a shorter single-tier
// narrowing, written only where it earns its keep (the topics whose
// cross-tier spread is the point) — topics without a `perTier` entry return
// `allTiers` regardless of the `tier` argument, which is itself honest: their
// content genuinely does not reduce to a one-tier sentence without losing the
// comparison that makes it useful.
//
// `sources` cites mined-note ids so a human or downstream agent can trace a
// claim back to the corpus (sources/mined/mcp-audit-rp-docs.md is the curated
// synthesis; sources/mined/rp-university-idea-backlog.md and the `.brain/notes/
// rp-university/` tree hold the notes themselves). `caveats` flags topics
// whose OWN source material disagrees with itself — recorded, never silently
// resolved, matching how the mined synthesis itself handles it.

import type { CoachingTopic } from '../schemas/coaching.js';

type Tier = 'beginner' | 'intermediate' | 'advanced';

export interface CoachingTopicContent {
  allTiers: string;
  perTier?: Partial<Record<Tier, string>>;
  sources: string[];
  caveats?: string[];
}

export const COACHING_CONTENT: Record<CoachingTopic, CoachingTopicContent> = {
  'onboarding.tier_inference': {
    allTiers:
      'Experience tier is NOT years-trained, and must never be inferred from a physique or ' +
      "progress photo — RP calls that 'actively misleading.' Someone can train five-plus years " +
      "under someone else's programming, never hit a genuine plateau, and still be functionally " +
      'a beginner. Promotion from beginner to intermediate requires ALL FOUR of: (1) technique ' +
      'holds under genuinely hard/near-failure sets, (2) the client reliably makes their ' +
      'committed weekly session count, (3) they have experienced a first genuine plateau, ' +
      '(4) they have moved past "does what they\'re told" to plan ownership. If any one of the ' +
      'four is absent, treat the client as still a beginner regardless of chronological time ' +
      'trained. Probe for a plateau event and for training breaks longer than a month — a raw ' +
      '"years training" self-report overestimates tier.',
    sources: [
      'rp-s4-beginner-definition-time-and-plateau',
      'rp-s4-graduation-signals-beginner-to-intermediate',
    ],
  },
  'onboarding.frequency_negotiation': {
    allTiers:
      'For beginners and advanced lifters, negotiate DOWN — contract for fewer sessions than ' +
      'the client offers (offered 5, contract 4), framing the extra as a bonus rather than a ' +
      'requirement. For INTERMEDIATES this reverses: the coach sometimes has to argue days ' +
      "UPWARD instead. A hard-coded 'always negotiate down' rule is wrong for intermediates — " +
      "it is the corpus's subtlest tier collision. Baseline session-count defaults: beginner " +
      '2-3/wk, intermediate 3-4/wk, advanced 4-6/wk; session length 45-60 min (two hours is ' +
      'explicitly called out as overkill).',
    sources: [
      'rp-s10-commit-to-fewer-sessions-than-offered',
      'rp-s5-days-per-week-negotiation',
      'rp-s1-sessions-per-week-default-beginner',
      'rp-s1-session-length-default',
    ],
  },
  'onboarding.goal_commitment_alignment': {
    allTiers:
      'Before committing to a plan, explicitly check that stated commitment (frequency, ' +
      'session length, intensity, nutrition adherence) is mathematically sufficient for the ' +
      'stated goal in the stated timeframe. Never proceed on a silent mismatch — if it does not ' +
      'add up, one of the three (goal / timeline / commitment) must change, and the client must ' +
      'explicitly agree to which. RP treats goal/commitment misalignment as the single most ' +
      'common cause of client dissatisfaction. Underpromise in the conversation (RP quantifies ' +
      'this at the advanced tier as dialling the honest internal estimate down 20-40%) — but ' +
      'never shade a NUMBER SHOWN in the product to match; show an honest range with ' +
      'uncertainty instead. Systematically displaying a number known to be below the real ' +
      'estimate is telling the user something believed false, and it corrupts every downstream ' +
      'comparison.',
    sources: [
      'rp-s1-commitment-goal-alignment-decision-rule',
      'rp-s10-underpromise-overdeliver-goal-setting',
      'rp-s6-underpromise-overdeliver-goal-setting',
    ],
  },
  'onboarding.injury_intake': {
    allTiers:
      'Injury/limitation intake is a three-tier ladder with one hard gate. (1) Cardiovascular ' +
      "limitations of any kind — ALWAYS defer to a doctor's clearance; never interpret these as " +
      'a non-clinically-trained coach. This is a liability boundary, not a feature flag. ' +
      '(2) Diagnosed musculoskeletal issues — ease in carefully around the documented issue. ' +
      '(3) Undiagnosed self-reported complaints ("I have a bad back") — start cautious, then ' +
      'DELIBERATELY push range and load at the margins over subsequent weeks, because most such ' +
      'complaints are functional or fear-avoidance rather than structural. Getting (1) and (3) ' +
      'backwards — gating on a self-reported ache while treating a cardiovascular flag as just ' +
      'another programming constraint — is the failure mode to avoid.',
    sources: ['rp-s10-injury-tier-system'],
  },
  'live.cue_budget': {
    allTiers:
      'Coaching cues are hard-capped at 1-2 per interval (pre-set, intra-set, post-set), and ' +
      'intra-set is stricter still: essentially 1-2 reminders of the SAME cue, almost never a ' +
      'new correction. Presenting multiple corrections at once means none of them land — not ' +
      'partial success on some. Cue density is also tier-gated: advanced lifters get SILENCE ' +
      'during the lift entirely, cued only between sets; intermediates get a couple of light ' +
      'in-set cues with the primary delivery as a post-set debrief; beginners get more frequent ' +
      'in-set cueing. Most generic coaching would treat every lifter the same.',
    perTier: {
      advanced:
        'Advanced: stay silent during the set entirely. Cue only between sets, capped ' +
        'at 1-2 per interval.',
      intermediate:
        'Intermediate: a couple of light in-set cues at most; the primary delivery channel is ' +
        'the post-set debrief, capped at 1-2 points.',
      beginner:
        'Beginner: more frequent in-set cueing is appropriate, but the 1-2-per-interval cap ' +
        'still holds — it governs how many DISTINCT points land per interval, not how often you ' +
        'speak.',
    },
    sources: [
      'rp-s3-cue-count-limit-per-interval',
      'rp-s5-technique-cue-during-vs-after-set',
      'rp-s4-cue-scaffolding-fade',
    ],
  },
  'live.cue_delivery': {
    allTiers:
      'Repeat the SAME cue across the pre/intra/post-set windows and across weeks — never ' +
      'rotate to a different correction mid-fault. Keep positively reinforcing a fault after it ' +
      'has resolved rather than silently dropping it from the coaching model ("that chest up ' +
      'was awesome," weeks later). If a cue is not landing, do NOT repeat it louder or more ' +
      'often — reword the underlying physical intent in different, more concrete language ' +
      '("push your butt back" -> "push your butt to try to touch the wall behind you"), or ' +
      'substitute a different cue. Non-response reflects a verbal-to-motor translation gap, not ' +
      'defiance. Tone also shifts mid-set: early reps get affirming, nuanced feedback; as ' +
      'failure nears and technique starts breaking down, switch to short, authoritative, ' +
      'single-phrase corrections repeated verbatim ("Chest up. Chest up."). The trigger for that ' +
      'shift is estimated proximity to failure (velocity loss / RIR), never a fixed rep number. ' +
      'Corrections themselves are always neutral-constructive, never critical — a bad rep is at ' +
      'worst neutral, so harsh feedback is never warranted. Praise, by contrast, should be ' +
      'genuine and specific, and should scale with the size of the milestone: quiet after a set, ' +
      'warmer after a session, most enthusiastic after a full mesocycle. Uniformly ' +
      'exclamation-heavy copy reads as inauthentic and erodes trust in all feedback.',
    sources: [
      'rp-s3-cue-timing-pre-during-post-set',
      'rp-s3-consistency-of-cueing-over-weeks',
      'rp-s3-cue-explain-if-not-landing',
      'rp-s3-coaching-tone-shift-near-failure',
      'rp-s5-technique-feedback-tone-rule',
      'rp-s1-escalating-praise-cadence',
    ],
  },
  'live.warmup_protocol': {
    allTiers:
      'The warm-up ramp itself — 12 reps at roughly 30RM, 8 at roughly 20RM, 4 at roughly 10RM, ' +
      'then working sets — is the one number in the corpus verified TIER-INVARIANT across ' +
      'beginner/intermediate/advanced. Do not generalise from it; nothing else here is universal. ' +
      'Warm-up SET COUNT, by contrast, is individualized per lifter and per exercise: some ' +
      'clients need only 2 warm-up sets, others need 4-5 (a large, technically demanding, ' +
      'systemically taxing lift like sumo deadlift may need 5; cable bicep curls may need only ' +
      '2 if biceps are already warm from earlier back work). Once a muscle is warm from a prior ' +
      'exercise\'s full ramp, a SECOND exercise for that same muscle needs only one brief "feel ' +
      'set" (roughly 3-6 reps at moderate load), not a repeat of the full ramp. Each warm-up set ' +
      'also carries a DIFFERENT coaching focus, not generic "warming up" copy: the 12-rep set ' +
      'establishes cadence and deliberate pauses; the 8-rep set finds/micro-adjusts target-muscle ' +
      'body position; the 4-rep set focuses on bracing and controlling the eccentric.',
    sources: [
      'rp-s5-warmup-ramp-1284',
      'rp-s5-warmup-set-count-individualization',
      'rp-s5-warmup-second-exercise-feel-set',
      'rp-s5-warmup-set-focus-progression',
    ],
  },
  'live.rir_estimation': {
    allTiers:
      'RIR self-report accuracy is sharply tier-split: beginners misjudge their own RIR by as ' +
      'much as 5-10 reps, and RP says beginners should not be tracking RIR at all — use ' +
      'technique-based progression instead. Intermediate and advanced lifters land within ' +
      'roughly 1-2 reps of their true RIR. Starting RIR targets also differ by tier: beginner ' +
      'never closer than 1-2 RIR; intermediate roughly 3 RIR in week 1, trending to 0 by the ' +
      'last pre-deload session; advanced 2-3 RIR generally, 1-2 for prioritized small muscles. ' +
      'RIR and RPE are NOT interchangeable — identical RIR carries wildly different RPE across ' +
      'exercises. Visible near-failure cues (bar slowdown, near-grind, facial strain, changed ' +
      'breathing, path deviation) combine to roughly 2-4 RIR on average, but fast-twitch lifters ' +
      'look fine until 1 RIR then fail abruptly, while slow-twitch lifters show signs as early ' +
      'as 8 RIR — a single population threshold misfits both.',
    perTier: {
      beginner:
        'Beginner: do not track RIR at all — self-report error runs 5-10 reps. Use ' +
        'technique-based progression, floor at "never closer than 1-2 RIR."',
      intermediate:
        'Intermediate: self-report lands within roughly 1-2 RIR. Start around 3 RIR in week 1, ' +
        'trending to 0 by the last pre-deload session.',
      advanced:
        'Advanced: self-report lands within roughly 1-2 RIR. Target 2-3 RIR generally, 1-2 RIR ' +
        'for prioritized small muscles.',
    },
    sources: [
      'rp-s7-rir-self-report-accuracy-by-tier',
      'rp-s4-beginner-rir-floor-progression',
      'rp-s7-rir-visual-cues-approaching-failure',
      'rp-s7-rir-vs-rpe-distinction',
    ],
    caveats: [
      'Backlog Addendum 2 re-scopes the velocity->RIR detector to a boolean "RIR <= 2" signal, ' +
        'not a continuous integer estimate — literature accuracy is only good near ' +
        'failure/heavy loads, in-session fits look good but fail to hold 72h later, and ' +
        'cable-machine transfer is entirely unstudied.',
    ],
  },
  'live.stop_set_signal': {
    allTiers:
      'A strong pump or a clear perturbation (cramping, marked weakness moving the muscle) that ' +
      'shows up after 1, 2, or 3 sets is a stop-adding-sets signal for that muscle right there — ' +
      'do not push to the originally planned set count. If nothing shows until set 4/5/6, ' +
      'continue to that point. The planned set number is not the authority; the live signal is. ' +
      'Junk volume is reps performed after fatigue has dropped achievable performance below the ' +
      'overload threshold — pure cost, no adaptation. Both this stop-set signal and the deload ' +
      'trigger it feeds are ADVISORY ONLY, binding per backlog decision: surface the signal, let ' +
      'the user decide, no hard stops, no silent defaults, always an explicit accept/decline. ' +
      'Telling a motivated user to stop is a strong intervention, and a false positive costs ' +
      'real training.',
    sources: [
      'rp-s5-per-set-checkin-protocol',
      'rp-s5-per-set-checkin-stop-rule',
      'rp-s2-junk-volume-definition',
    ],
  },
  'meso.deload_trigger': {
    allTiers:
      'Deload triggering is performance-gated, full stop: two CONSECUTIVE sessions of the same ' +
      'muscle (not just two workouts) where load and/or reps come in lower than that same ' +
      'session one week earlier. One off-session is noise; two is unequivocal evidence. ' +
      'Performance is the "grand integrator" of recovery status. Critically, soreness/recovery-' +
      "timing signals should move next week's SET COUNT (cheap, per-muscle, reversible) — only " +
      'a measured PERFORMANCE DECLINE should trigger a DELOAD (expensive, whole-block). ' +
      'Subjective fatigue is a leading indicator that can raise sensitivity, but is never an ' +
      'independent deload trigger on its own. The one partial exception is beginner tier, where ' +
      'joint/connective soreness (never plain muscle DOMS) can contribute to the composite — but ' +
      'even there the performance stall is still required.',
    sources: [
      'rp-s7-two-session-underperformance-trigger',
      'rp-s7-subjective-fatigue-leading-indicator-not-gate',
      'rp-s4-beginner-overreaching-signals',
    ],
  },
  'meso.deload_ladder': {
    allTiers:
      'Deload is a five-rung ladder with real magnitudes, selected by breach scope — not a ' +
      'single on/off button. (1) Off day: at least one per week for everyone. (2) Recovery ' +
      'session: still train, but cut volume, load and reps roughly in half, with substantially ' +
      'more RIR. (3) Recovery half-week: convert half the training week to recovery sessions, ' +
      'buying roughly 1.5-2.5 extra weeks of continued progressive training mid-mesocycle. ' +
      '(4) Deload week: a full week at recovery level (not zero training) — needed because a ' +
      'half-week alone cannot clear joint/connective-tissue or deep psychological fatigue. ' +
      '(5) Active rest phase: roughly two weeks (one deload week plus one fully off week), ' +
      'once or twice a year. Rung selection follows breach scope: a single-muscle breach calls ' +
      'for a recovery session; more than one muscle breaching in the same rolling week calls for ' +
      'a whole-body recovery half-week; repeated or systemic breaches call for a full deload. ' +
      'Deload CADENCE is tier-split: beginners may go six months or longer with no deload at ' +
      'all, symptom-triggered only, since a fixed calendar trigger fires before any real need ' +
      'exists. Intermediates run roughly 4:1 or 5:1 accumulation-to-deload (5-6 week ' +
      'mesocycles) — for unknown tolerance, commit to only 3 weeks and extend week-by-week ' +
      'rather than trusting a self-reported "I go 10 weeks." Advanced lifters run roughly 3:1 ' +
      'or 4:1; a claim of 6-8 weeks without a deload is itself treated as evidence the lifter ' +
      "isn't truly advanced or isn't training hard enough — one sanctioned exception being that " +
      'if they are still upright and still gaining at the end of week 4, add one more ' +
      'accumulation week rather than mechanically deloading. The ratio is only a planning ' +
      'prior; the actual trigger always stays performance-based.',
    perTier: {
      beginner:
        'Beginner: no fixed cadence — may go 6+ months with zero deloads, ' +
        'symptom-triggered only.',
      intermediate:
        'Intermediate: roughly 4:1 or 5:1 accumulation-to-deload (5-6 week mesocycles); commit ' +
        'to only 3 weeks up front for an unknown tolerance and extend week-by-week.',
      advanced:
        'Advanced: roughly 3:1 or 4:1. A claimed 6-8 weeks without a deload is a red flag, not a ' +
        'datapoint — unless still gaining and upright at week 4, in which case add one more ' +
        'accumulation week.',
    },
    sources: [
      'rp-s2-fatigue-reduction-ladder',
      'rp-s6-local-vs-systemic-fatigue-response',
      'rp-s5-multi-muscle-underperformance-systemic',
      'rp-s4-beginner-no-deload-for-months',
    ],
  },
  'meso.volume_progression': {
    allTiers:
      'Set count is a REACTIVE FATIGUE DIAL, never a progression lever — the same shape at ' +
      "every tier, driven by recovery timing relative to the muscle's next actual session. " +
      'Recovered well ahead of that session: add one set (not two, to avoid overshooting). ' +
      'Recovered exactly on time: hold — "this is the right amount." One overlap, or a single ' +
      'missed performance: hold and wait, the body usually catches up. Severe overlap, or twice: ' +
      'cut 1-2 sets. Frame a set REDUCTION proactively as finding the right number, never as a ' +
      'demotion — RP names the exact client objection to prepare for: "we did 5 last week and ' +
      "3 this week, doesn't that mean I won't grow?\" Starting volume should err low for a " +
      'decision-theoretic reason, not a "less is better" one: under-dosing week 1 is free to ' +
      'correct next week, while over-dosing leaves cumulative fatigue debt that carries forward ' +
      'even after the number is fixed. Tier ceilings: beginner roughly 5 sets/exercise, 5-8 ' +
      'sets/muscle/session, 10-20 hard sets/muscle/week; intermediate attractor 2-4 ' +
      'sets/exercise/session (4-8/muscle in week 1); advanced often adds zero or one set across ' +
      'an ENTIRE mesocycle — a naive "+1 set/week" rule is an advanced-tier overreach generator.',
    perTier: {
      beginner:
        'Beginner: roughly 5 sets/exercise, 5-8 sets/muscle/session, 10-20 hard ' +
        'sets/muscle/week.',
      intermediate: 'Intermediate: attractor of 2-4 sets/exercise/session (4-8/muscle in week 1).',
      advanced:
        'Advanced: often zero or one set added across an entire mesocycle. A naive ' +
        '"+1 set/week" rule badly overreaches at this tier.',
    },
    sources: [
      'rp-s5-set-addition-not-progression-tool',
      'rp-s5-set-addition-decision-rule',
      'rp-s6-set-progression-state-machine',
      'rp-s5-set-reduction-not-a-demotion',
      'rp-s5-volume-err-low-first-week',
      'rp-s5-volume-history-calibration-conversation',
    ],
  },
  'meso.post_deload_restart': {
    allTiers:
      "The post-deload load restart is the corpus's most dangerous number, because the tier " +
      'answers point in opposite directions. Beginners resume at, or above, the prior ' +
      "mesocycle's PEAK — but RP is explicit that doing the same thing to an intermediate or " +
      'advanced lifter causes immediate overreaching. Intermediates instead restart at the ' +
      "prior mesocycle's week-2-or-3 load. Advanced lifters recycle at roughly two-thirds of " +
      'their prior set count, with a fresh RIR target. The general anchoring principle: the ' +
      'next mesocycle should start only slightly above where the PREVIOUS one STARTED, not ' +
      'where it peaked — a deload only raises the overload threshold a small amount. When ' +
      'uncertain, guess low: underestimating costs a little correctable progress; overestimating ' +
      "costs fatigue AND the trainee's confidence. Post-deload, load and set count reset as " +
      'independent variables.',
    perTier: {
      beginner: "Beginner: resume at, or above, the prior mesocycle's peak.",
      intermediate:
        "Intermediate: restart at the prior mesocycle's week-2-or-3 load — resuming " +
        'at peak (the beginner rule) would overreach here.',
      advanced:
        'Advanced: recycle at roughly two-thirds of the prior set count, with a fresh ' +
        'RIR target.',
    },
    sources: ['rp-s2-next-mesocycle-starting-load', 'rp-s4-post-deload-load-restart'],
  },
  'meso.exercise_rotation': {
    allTiers:
      "An exercise's stimulus-to-fatigue ratio (SFR) rises after introduction, stabilizes, then " +
      "declines. Keep an exercise as long as its SFR is at or above the next-best alternative's; " +
      'trigger a swap only once it falls distinctly below — not on any dip. A newly introduced ' +
      "exercise's SFR is temporarily inflated by novelty, so smooth over that window before " +
      "trusting the comparison; an unused alternative's SFR likewise rises the longer it sits " +
      'idle (resensitization). Boredom alone is NOT sufficient reason to swap mid-mesocycle — if ' +
      'SFR/performance is still fine, finish the block; only physiological staleness (not ' +
      'psychological/boredom) justifies an immediate swap, and a boredom-driven swap request ' +
      'should be checked against the objective trend before being honoured. Hit the target with ' +
      'the SAME exercises repeatedly within a mesocycle — rotation dilutes the training signal. ' +
      'Beginner rotation is capped at roughly 25% per cycle. Order variant pools with ' +
      'lower-stimulus variants early in a block, saving higher-stimulus variants for later. ' +
      "Advanced lifters can vary an exercise's CONTEXT (position, rep range, grip) rather than " +
      'replacing it, to manage local joint stress without losing a proven-SFR movement — with ' +
      'true exploration time-boxed to the post-diet rebound phase only.',
    sources: [
      'rp-s7-sfr-staleness-exercise-swap-trigger',
      'rp-s2-staleness-sfr-monitoring',
      'rp-s7-novelty-effect-inflates-sfr-temporarily',
      'rp-s2-physiological-vs-psychological-staleness',
      'rp-s2-directed-adaptation',
      'rp-s4-exercise-rotation-quarter-rule',
      'rp-s6-exercise-variation-without-swapping',
    ],
  },
  'diet.phase_coupling': {
    allTiers:
      'Diet phase and training phase are coupled but INDEPENDENT clocks — this is the ' +
      'load-bearing idea. A fat-loss phase produces its own diet fatigue (hunger, low energy, ' +
      'poor concentration, elevated muscle-loss risk, degraded sleep) that rises roughly ' +
      'exponentially and is largely independent of the training program. A muscle-gain phase ' +
      'produces a separate training fatigue from continual high-volume overload, unrelated to ' +
      "caloric state. You can't clear one kind of fatigue by only addressing the other. " +
      'Practically: if a user has been in an extended fat-loss phase, reduced bar-speed/load ' +
      'progression and even slight strength regression are EXPECTED behavior, not a stall — ' +
      'widen the app\'s "normal" band or suppress plateau alerts based on weeks-in-phase. This ' +
      'only needs a coarse phase tag (fat-loss / gain / maintenance / active-rest) plus ' +
      'weeks-in-phase, not calorie logs. Diet fatigue itself tracks cumulative percent body ' +
      'weight lost, not elapsed time: roughly 3-5% lost is little/no fatigue regardless of ' +
      'speed; roughly 7-10% is noticeable fatigue in most people; over 10% in one continuous ' +
      'phase is almost always significant fatigue — going faster just front-loads the same ' +
      'cumulative fatigue rather than avoiding it.',
    sources: [
      'rp-s11-diet-phase-training-fatigue-coupling',
      'rp-s11-diet-fatigue-pct-weight-lost-proxy',
    ],
  },
  'diet.phase_durations': {
    allTiers:
      'Fat-loss phases run roughly 8-12 weeks (S11) to 1-3 months (S5/S6 advanced) — under a ' +
      'month rarely produces meaningful results, and past roughly three months diet fatigue ' +
      'itself becomes the limiting problem. Muscle-gain phases run 2-4 months per S5/S6, though ' +
      'S11 states this inconsistently (recorded as a self-contradiction in the source material, ' +
      'not silently resolved — see caveat). Fat-loss recovery runs roughly 4-8 weeks of ' +
      'maintenance or slow gain; post-gain cleanup is roughly 2-4 weeks of active rest plus a ' +
      '3-8 week mini-cut, capped at 1-2 repetitions per macrocycle. Maintenance phases are a ' +
      'recovery bridge, not a growth phase — say so explicitly to users so slow maintenance ' +
      'progress does not read as program failure. Rates: fat loss roughly 0.5-1% body weight ' +
      'per week (about 8% over six months); muscle gain roughly 0.25-0.5% per week, tier-split ' +
      'about 6x (roughly 6% lean mass in six months for a beginner, roughly 2% population ' +
      'average, roughly 1% or less for advanced). Muscle-gain estimates carry wider uncertainty ' +
      'bands than fat loss, since fat loss is closer to deterministic calorie math while muscle ' +
      'gain also depends on genetics and training.',
    sources: [
      'rp-s5-diet-phase-duration-intermediate',
      'rp-s11-musclegain-pace-beginner',
      'rp-s11-weightloss-vs-musclegain-predictability',
    ],
    caveats: [
      'S11 self-contradicts on three numbers inside single lectures, per the mined ' +
        'synthesis: goal horizon stated as 1 year then corrected to 3-6 months; muscle-gain ' +
        'phase length given as both 12-20 and 8-20 weeks; recovery block given as both 2-4 and ' +
        '1-2 weeks. Each is quoted here as a range with this caveat attached, not resolved to a ' +
        'single number.',
    ],
  },
  'diet.disruption_handling': {
    allTiers:
      'Known disruption windows (holidays, religious observances, travel, seasonal timing) get ' +
      'planned AROUND — default to maintenance or active rest rather than pushing an active diet ' +
      'or training phase through them. When a disruption is UNPLANNED, give an explicit, bounded ' +
      'holding instruction immediately ("2 weeks active rest, then reassess") rather than open-' +
      'ended silence — the ambiguity itself, not the disruption, is the more psychologically ' +
      'damaging thing. A client who can never hold a phase more than a few days needs a forced ' +
      'long hold or explicit disengagement, not endless re-planning. Missed or lighter sessions ' +
      'during a flagged disruption window should read to the user as expected, not as an ' +
      'adherence failure.',
    sources: ['rp-s11-unplanned-disruption-protocol', 'rp-s11-chronic-plan-abandonment-response'],
  },
};
