// Hand-curated cable-exercise seed catalog.
//
// `@voltras/workout-analytics@1.1.0` ships with an empty
// `dist/esm/exercises/data/catalog.json` (the upstream collection pipeline
// hasn't been run + published). With nothing in the catalog,
// `searchExercises()` and `getExerciseById()` always return empty / undefined,
// so the MCP `exercise.search` / `exercise.get` tools are useless to PT
// Claude. Until the analytics package ships a real catalog, we inject this
// hand-curated base set at server boot via `setCatalog()`.
//
// Scope: ~30 common cable-machine exercises spanning push / pull / legs /
// core. Every entry is `cableEquivalent: true` and carries a `cableSetup`
// — this catalog is intentionally Voltra-shaped, not a full
// hardware-agnostic exercise library. When the upstream catalog lands, swap
// the bootstrap call to `loadCatalog()` and delete this file.
//
// Type-safety: we import `Exercise` directly from `@voltras/workout-analytics`
// so a future package upgrade that tightens the schema (e.g. constrains
// `MovementPatternId` further) breaks the build here rather than silently
// shipping a malformed catalog.

import type { Exercise } from '@voltras/workout-analytics';

/**
 * Convenience: every entry uses identical equipment + `cableEquivalent: true`.
 * Centralising avoids ~30 inline duplicates and keeps the entry literal focused
 * on the lift-specific fields (movement pattern, muscle groups, cable setup).
 */
const VOLTRA_EQUIPMENT: Exercise['equipment'] = [{ name: 'Voltra', category: 'cable' }];

/**
 * Hand-curated cable-exercise seed catalog. Order is push → pull → legs → core
 * to mirror common programming flow; the analytics catalog itself is unordered
 * (lookup is by id / muscle group / pattern).
 */
export const SEED_CABLE_EXERCISES: Exercise[] = [
  // ──────────────────────────────────────────────────────────────────────
  // Push — chest, shoulders, triceps
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'cable-chest-press',
    name: 'Cable Chest Press',
    aliases: [
      'cable bench press',
      'standing cable press',
      'VTS bench',
      'VTS Smith bench',
      'Smith bench press',
    ],
    muscleGroups: ['chest'],
    secondaryMuscleGroups: ['shoulders', 'triceps'],
    movementPattern: 'push',
    exerciseType: 'compound',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'mid',
      attachments: ['d_handle'],
      notes: 'Stagger stance, handles at chest height, press straight forward.',
    },
    formCues: [
      'Brace core, neutral spine — no torso lean',
      'Drive hands forward, not down',
      'Full lockout, controlled return',
    ],
    qualityScore: 9,
  },
  {
    id: 'cable-incline-chest-press',
    name: 'Cable Incline Chest Press',
    aliases: ['low to high cable press'],
    muscleGroups: ['chest'],
    secondaryMuscleGroups: ['shoulders', 'triceps'],
    movementPattern: 'push',
    exerciseType: 'compound',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['d_handle'],
      notes: 'Press up and forward at ~30° angle to bias upper chest.',
    },
    formCues: [
      'Drive hands up and toward midline',
      'Keep elbows ~45° from torso',
      'Squeeze upper chest at lockout',
    ],
    qualityScore: 8,
  },
  {
    id: 'cable-chest-fly',
    name: 'Cable Chest Fly',
    aliases: ['cable flye', 'standing cable fly'],
    muscleGroups: ['chest'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'mid',
      attachments: ['d_handle'],
      notes: 'Slight elbow bend held throughout; arc hands together in front.',
    },
    formCues: [
      'Maintain fixed elbow angle — no pressing',
      'Squeeze chest at full adduction',
      "Stretch but don't over-extend at the back of the rep",
    ],
    qualityScore: 7,
  },
  {
    id: 'cable-low-to-high-fly',
    name: 'Cable Low-to-High Fly',
    aliases: ['cable upper chest fly'],
    muscleGroups: ['chest'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['d_handle'],
      notes: 'Sweep arms upward and inward to shoulder/eye height.',
    },
    formCues: [
      'Slight elbow bend, fixed throughout',
      'Finish with hands meeting at chin level',
      'Drive from the chest, not the shoulders',
    ],
    qualityScore: 7,
  },
  {
    id: 'cable-high-to-low-fly',
    name: 'Cable High-to-Low Fly',
    aliases: ['cable lower chest fly'],
    muscleGroups: ['chest'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'high',
      attachments: ['d_handle'],
      notes: 'Sweep arms downward and inward, finishing near hip height.',
    },
    formCues: [
      'Slight elbow bend, fixed throughout',
      'Cross hands at the bottom for full contraction',
      'Slight forward lean to track lower-pec fibers',
    ],
    qualityScore: 7,
  },
  {
    id: 'cable-shoulder-press',
    name: 'Cable Shoulder Press',
    aliases: ['cable overhead press', 'VTS overhead press', 'Smith shoulder press'],
    muscleGroups: ['shoulders'],
    secondaryMuscleGroups: ['triceps', 'traps'],
    movementPattern: 'push',
    exerciseType: 'compound',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['d_handle'],
      notes: 'Start with handles at shoulder height, press overhead.',
    },
    formCues: [
      'Lock core — no lower-back arch',
      'Press straight up, not forward',
      'Full lockout overhead, ears between biceps',
    ],
    qualityScore: 8,
  },
  {
    id: 'cable-lateral-raise',
    name: 'Cable Lateral Raise',
    aliases: ['cable side raise', 'single arm cable lateral'],
    muscleGroups: ['shoulders'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['d_handle'],
      notes: 'Single-arm; cable runs across body, raise arm straight out to the side.',
    },
    formCues: [
      'Lead with the elbow, not the hand',
      'Stop at shoulder height — no shrugging',
      'Slow eccentric, no swing',
    ],
    qualityScore: 7,
  },
  {
    id: 'cable-front-raise',
    name: 'Cable Front Raise',
    muscleGroups: ['shoulders'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['straight_bar'],
      notes: 'Stand facing away from anchor; raise bar straight forward to eye level.',
    },
    formCues: [
      'No torso swing — brace core',
      'Stop at eye level, not overhead',
      'Slight elbow bend held throughout',
    ],
    qualityScore: 6,
  },
  {
    id: 'cable-rear-delt-fly',
    name: 'Cable Rear Delt Fly',
    aliases: ['cable reverse fly', 'face-level fly'],
    muscleGroups: ['shoulders'],
    secondaryMuscleGroups: ['back', 'traps'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'high',
      attachments: ['d_handle'],
      notes: 'Cross cables at chest, pull hands apart and back at face height.',
    },
    formCues: [
      'Lead with the elbows, hands stay wide',
      'Squeeze shoulder blades at end range',
      'Keep neck relaxed — no shrug',
    ],
    qualityScore: 7,
  },
  {
    id: 'cable-tricep-pushdown',
    name: 'Cable Tricep Pushdown',
    aliases: ['cable pushdown', 'rope pushdown'],
    muscleGroups: ['triceps'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'high',
      attachments: ['rope', 'straight_bar'],
      notes: 'Elbows pinned to ribs, extend forearms fully down.',
    },
    formCues: [
      'Elbows stay glued to your sides',
      'Full lockout — squeeze the back of the arm',
      'Control the eccentric, no rebound at top',
    ],
    qualityScore: 8,
  },
  {
    id: 'cable-overhead-tricep-extension',
    name: 'Cable Overhead Tricep Extension',
    aliases: ['cable french press'],
    muscleGroups: ['triceps'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['rope'],
      notes: 'Face away from anchor, rope behind head, extend arms overhead.',
    },
    formCues: [
      'Upper arms stay vertical, elbows pointing up',
      'Full stretch at the bottom, full lockout at the top',
      'No flaring elbows — keep them tracking forward',
    ],
    qualityScore: 7,
  },

  // ──────────────────────────────────────────────────────────────────────
  // Pull — back, biceps
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'cable-row',
    name: 'Cable Row',
    aliases: ['seated cable row', 'VTS row', 'Smith row'],
    muscleGroups: ['back'],
    secondaryMuscleGroups: ['biceps', 'shoulders'],
    movementPattern: 'pull',
    exerciseType: 'compound',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'mid',
      attachments: ['v_bar', 'straight_bar'],
      notes: 'Seated or standing; pull handle to lower ribcage.',
    },
    formCues: [
      'Drive elbows back, not up',
      'Squeeze shoulder blades together at end range',
      'Neutral spine — no rounding or hyperextension',
    ],
    qualityScore: 9,
  },
  {
    id: 'cable-single-arm-row',
    name: 'Cable Single-Arm Row',
    aliases: ['unilateral cable row'],
    muscleGroups: ['back'],
    secondaryMuscleGroups: ['biceps'],
    movementPattern: 'pull',
    exerciseType: 'compound',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'mid',
      attachments: ['d_handle'],
      notes: 'Stagger stance, pull handle to hip with full retraction.',
    },
    formCues: [
      'Lead with the elbow, finish with the scapula',
      'No torso rotation at the end — keep shoulders square',
      'Full stretch at the front of the rep',
    ],
    qualityScore: 8,
  },
  {
    id: 'cable-lat-pulldown',
    name: 'Cable Lat Pulldown',
    aliases: ['lat pulldown', 'pulldown'],
    muscleGroups: ['back'],
    secondaryMuscleGroups: ['biceps', 'shoulders'],
    movementPattern: 'pull',
    exerciseType: 'compound',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'high',
      attachments: ['straight_bar', 'v_bar'],
      notes: 'Pull bar to upper chest, elbows driving down and back.',
    },
    formCues: [
      'Pull with the lats — think elbows to hips',
      'Slight backward lean, not full leanback',
      'Stop at upper chest, not chin',
    ],
    qualityScore: 9,
  },
  {
    id: 'cable-straight-arm-pulldown',
    name: 'Cable Straight-Arm Pulldown',
    aliases: ['straight arm pulldown'],
    muscleGroups: ['back'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'high',
      attachments: ['straight_bar', 'rope'],
      notes: 'Arms straight, sweep bar from overhead to thighs.',
    },
    formCues: [
      'Arms stay straight (slight elbow bend ok)',
      'Drive hands down with the lats, not the triceps',
      'Slight forward lean, hinge at the hip',
    ],
    qualityScore: 7,
  },
  {
    id: 'cable-face-pull',
    name: 'Cable Face Pull',
    muscleGroups: ['shoulders'],
    secondaryMuscleGroups: ['back', 'traps'],
    movementPattern: 'pull',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'high',
      attachments: ['rope'],
      notes: 'Pull rope toward eyes/forehead, hands separating to the sides.',
    },
    formCues: [
      'Lead with the elbows, hands flare out',
      'Externally rotate at the top — hands above elbows',
      'No shrugging — keep traps relaxed',
    ],
    qualityScore: 8,
  },
  {
    id: 'cable-bicep-curl',
    name: 'Cable Bicep Curl',
    aliases: ['cable curl'],
    muscleGroups: ['biceps'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['straight_bar', 'd_handle'],
      notes: 'Elbows pinned, curl bar to shoulder height.',
    },
    formCues: [
      'Elbows fixed at your sides',
      'No swinging — control the eccentric',
      'Full lockout at the bottom for stretch',
    ],
    qualityScore: 8,
  },
  {
    id: 'cable-hammer-curl',
    name: 'Cable Hammer Curl',
    aliases: ['cable rope hammer curl'],
    muscleGroups: ['biceps'],
    secondaryMuscleGroups: ['forearms'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['rope'],
      notes: 'Neutral grip on rope, curl up keeping palms facing each other.',
    },
    formCues: [
      'Palms face each other the entire rep',
      'Elbows stay glued to ribs',
      'Squeeze at the top, control on the way down',
    ],
    qualityScore: 7,
  },
  {
    id: 'cable-rope-curl',
    name: 'Cable Rope Curl',
    muscleGroups: ['biceps'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['rope'],
      notes: 'Curl rope ends apart at the top to bias the brachialis and outer bicep.',
    },
    formCues: [
      'Spread rope ends at the top of the curl',
      'Elbows pinned, no shoulder flexion',
      'Slow eccentric',
    ],
    qualityScore: 6,
  },
  {
    // VMCP-02.37: positional bicep variant. The working arm stays behind the
    // torso, loading the long head from a deep stretch — biomechanically
    // distinct from a standard curl, so it earns its own entry rather than an
    // alias on `cable-bicep-curl`.
    id: 'cable-bayesian-curl',
    name: 'Cable Bayesian Curl',
    aliases: ['bayesian curl', 'behind-the-body cable curl'],
    muscleGroups: ['biceps'],
    secondaryMuscleGroups: ['forearms'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['d_handle'],
      notes:
        'Face away from the cable origin so the working arm stays behind the torso; ' +
        'the upper arm angles back to load the biceps long head in a deep stretch.',
    },
    formCues: [
      'Keep the elbow drawn behind your torso for the whole set',
      'Let the cable pull you into a full stretch at the bottom',
      'Curl without letting the upper arm drift forward',
    ],
    qualityScore: 7,
  },

  // ──────────────────────────────────────────────────────────────────────
  // Legs — quads, hamstrings, glutes, hips
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'cable-squat',
    name: 'Cable Squat',
    aliases: ['cable goblet squat', 'VTS squat', 'VTS Smith squat', 'Smith squat'],
    muscleGroups: ['quads'],
    secondaryMuscleGroups: ['glutes', 'hamstrings', 'core'],
    movementPattern: 'squat',
    exerciseType: 'compound',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['d_handle', 'rope'],
      notes: 'Hold handles at chest, squat to depth, drive up through heels.',
    },
    formCues: [
      'Knees track over toes, not collapsing in',
      'Chest up, neutral spine',
      'Drive through the floor, not just up',
    ],
    qualityScore: 8,
  },
  {
    id: 'cable-romanian-deadlift',
    name: 'Cable Romanian Deadlift',
    aliases: ['cable RDL', 'VTS RDL', 'VTS Romanian deadlift', 'Smith RDL'],
    muscleGroups: ['hamstrings'],
    secondaryMuscleGroups: ['glutes', 'back'],
    movementPattern: 'hinge',
    exerciseType: 'compound',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['straight_bar'],
      notes: 'Hinge at hips, slight knee bend, bar stays close to legs.',
    },
    formCues: [
      'Hinge at the hips — push the hips back',
      'Slight, fixed knee bend throughout',
      'Stop at mid-shin or when hamstrings limit',
      'Squeeze glutes at lockout',
    ],
    qualityScore: 9,
  },
  {
    id: 'cable-glute-kickback',
    name: 'Cable Glute Kickback',
    aliases: ['cable kickback'],
    muscleGroups: ['glutes'],
    secondaryMuscleGroups: ['hamstrings'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['ankle_strap'],
      notes: 'Ankle strap, kick straight back keeping torso braced.',
    },
    formCues: [
      'Squeeze the glute at end range',
      'No lower-back arch — keep core tight',
      'Slow eccentric back to neutral',
    ],
    qualityScore: 7,
  },
  {
    id: 'cable-hip-abduction',
    name: 'Cable Hip Abduction',
    aliases: ['standing cable abduction'],
    muscleGroups: ['glutes'],
    secondaryMuscleGroups: ['abductors'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['ankle_strap'],
      notes: 'Cable on inside ankle; raise leg straight out to the side.',
    },
    formCues: [
      'Keep the moving leg straight, no knee bend',
      'No hip hike or torso lean',
      'Squeeze the side glute at the top',
    ],
    qualityScore: 6,
  },
  {
    id: 'cable-hip-adduction',
    name: 'Cable Hip Adduction',
    aliases: ['standing cable adduction'],
    muscleGroups: ['adductors'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['ankle_strap'],
      notes: 'Cable on outside ankle; pull leg across body toward midline.',
    },
    formCues: [
      'Keep the moving leg straight',
      'Brace core to prevent torso shift',
      'Pull all the way across, not just to neutral',
    ],
    qualityScore: 6,
  },
  {
    id: 'cable-pull-through',
    name: 'Cable Pull-Through',
    muscleGroups: ['glutes'],
    secondaryMuscleGroups: ['hamstrings', 'back'],
    movementPattern: 'hinge',
    exerciseType: 'compound',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['rope'],
      notes: 'Face away, rope between legs, hinge and stand by driving hips forward.',
    },
    formCues: [
      'Hinge at the hips — push hips back, then forward',
      'Squeeze glutes hard at lockout',
      "Arms passive — they're just hooks for the rope",
    ],
    qualityScore: 8,
  },

  // ──────────────────────────────────────────────────────────────────────
  // Core — rotation, anti-rotation, flexion
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'cable-woodchopper',
    name: 'Cable Woodchopper',
    aliases: ['high to low chop', 'cable chop'],
    muscleGroups: ['obliques'],
    secondaryMuscleGroups: ['core', 'shoulders'],
    movementPattern: 'rotation',
    exerciseType: 'compound',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'high',
      attachments: ['d_handle', 'rope'],
      notes: 'Stand sideways to anchor, pull from high overhead diagonally to opposite hip.',
    },
    formCues: [
      'Rotate from the torso, not the arms',
      'Pivot the back foot to release the hip',
      'Control the return — no slingshot',
    ],
    qualityScore: 7,
  },
  {
    id: 'cable-pallof-press',
    name: 'Cable Pallof Press',
    aliases: ['anti-rotation press'],
    muscleGroups: ['core'],
    secondaryMuscleGroups: ['obliques'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'mid',
      attachments: ['d_handle'],
      notes: 'Stand sideways to anchor, press handle straight out from chest, resist rotation.',
    },
    formCues: [
      "Don't let the cable rotate you — that's the whole exercise",
      'Press straight out, not toward the anchor',
      'Brace core hard, breathe shallowly',
    ],
    qualityScore: 8,
  },
  {
    id: 'cable-crunch',
    name: 'Cable Crunch',
    aliases: ['kneeling cable crunch'],
    muscleGroups: ['abs'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'high',
      attachments: ['rope'],
      notes: 'Kneel facing anchor, rope behind head, crunch by flexing the spine.',
    },
    formCues: [
      'Curl the torso — chest to pelvis, not hips to floor',
      "Hips stay fixed — don't hinge from the hip",
      'Squeeze abs at the bottom of the crunch',
    ],
    qualityScore: 7,
  },
  {
    id: 'cable-side-bend',
    name: 'Cable Side Bend',
    aliases: ['standing cable side bend'],
    muscleGroups: ['obliques'],
    movementPattern: 'isolation',
    exerciseType: 'isolation',
    equipment: VOLTRA_EQUIPMENT,
    cableEquivalent: true,
    cableSetup: {
      cablePath: 'low',
      attachments: ['d_handle'],
      notes: 'Stand sideways to anchor, single-arm; bend laterally away from the cable.',
    },
    formCues: [
      'Pure lateral flexion — no forward lean',
      'Free hand on hip or behind head, not assisting',
      'Slow eccentric back to upright',
    ],
    qualityScore: 6,
  },
];
