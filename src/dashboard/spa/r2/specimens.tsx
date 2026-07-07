/**
 * Specimens — family-by-family approval sheets for the delta components
 * (operator-approved strategy: each sheet's approval converts to one TD
 * ticket).
 *
 * Every sheet shows: (1) a 390px PHONE FRAME at current/shared density (the
 * mobile contract — must stay good), (2) the WALL SCALE rendering + proposed
 * variant at 1280-viewport scale, (3) the usual fidelity labels, (4) an
 * APPROVAL BLOCK with the dimensional-audit's concrete open questions (px
 * values + proposed prop API). All driven by the same fixture data + WA
 * cable zones so colors/zoning agree everywhere.
 */
import React, { useState } from 'react';
import { Heading, TempoBar, calculateMeanVelocity, formatVelocity } from '@titan-design/react-ui';
import { CABLE_ZONES, LIVE, SESSION } from './fixture';
import type { SimState } from './sim';
import { F } from './fidelity';
import { HeroVelocityBars, heroZoneColor } from './herobars';
import { RestRing } from './restring';
import { CueFlag, FatigueMeter, StatusPill } from './status';
import { VelocityStripCompat, RestTimerCompat } from './titan-compat';
import { WallScale } from './wallscale';

type FamilyKey = 'A' | 'B' | 'C' | 'D';

const FAMILIES: Array<{ key: FamilyKey; label: string }> = [
  { key: 'A', label: 'A · Live velocity' },
  { key: 'B', label: 'B · Tempo' },
  { key: 'C', label: 'C · Exertion' },
  { key: 'D', label: 'D · Rest' },
];

/** Fixed specimen rep set = the live fixture stream (same data everywhere). */
const SPECIMEN_REPS = LIVE.stream.slice(0, 6);

function PhoneFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="r2-spec-phone">
      <div className="r2-spec-phone-label">phone · 390px — mobile contract (unchanged)</div>
      <div className="r2-spec-phone-body">{children}</div>
    </div>
  );
}

function WallPane({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="r2-spec-wall">
      <div className="r2-spec-wall-label">wall scale · 1280 viewport, 2–3 m glance</div>
      <div className="r2-spec-wall-body">{children}</div>
    </div>
  );
}

function ApprovalBlock({
  family,
  api,
  questions,
}: {
  family: string;
  api: string;
  questions: string[];
}): React.JSX.Element {
  return (
    <div className="r2-spec-approve">
      <div className="r2-spec-approve-head">APPROVAL BLOCK — {family} → one TD ticket</div>
      <code className="r2-spec-api">{api}</code>
      <ul>
        {questions.map((q, i) => (
          <li key={i}>{q}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * VelocityStrip mini `size='wall'` candidate. Uniform DOM scaling cannot
 * produce the audit's proposed geometry (bar aspect changes: 4×3 → 9×24-28),
 * so this MIRRORS the mini's markup exactly (row of zone-colored bars,
 * height ∝ velocity) at wall density — stated per the fidelity rules.
 */
function WallMiniBars({ reps }: { reps: number[] }): React.JSX.Element {
  const mx = Math.max(0.75, ...reps) * 1.12;
  return (
    <div className="r2-wallmini" role="img" aria-label="Wall mini velocity bars">
      {reps.map((v, i) => (
        <div
          key={i}
          style={{
            width: 9,
            height: `${Math.max(15, (v / mx) * 100)}%`,
            background: heroZoneColor(v, CABLE_ZONES),
            borderRadius: 2,
          }}
        />
      ))}
    </div>
  );
}

function FamilyA(): React.JSX.Element {
  const reps = SPECIMEN_REPS;
  return (
    <div className="r2-spec-sheet">
      <PhoneFrame>
        <div className="r2-panel-label">VelocityStrip mini · current (also the pinned strip)</div>
        <F kind="real" name="titan:VelocityStrip mini" block={false}>
          <VelocityStripCompat velocities={reps} variant="mini" zones={CABLE_ZONES} />
        </F>
        <div className="r2-panel-label">VelocityStrip expanded · current (review columns)</div>
        <F kind="real" name="titan:VelocityStrip (expanded, zones)">
          <VelocityStripCompat velocities={reps} expanded showInfo zones={CABLE_ZONES} />
        </F>
      </PhoneFrame>
      <WallPane>
        <div className="r2-panel-label">
          mini at wall (real, unchanged — 16×3 px: the audit's worst offender)
        </div>
        <F kind="real" name="titan:VelocityStrip mini" block={false}>
          <VelocityStripCompat velocities={reps} variant="mini" zones={CABLE_ZONES} />
        </F>
        <div className="r2-panel-label">mini size='wall' · candidate (mirrored markup)</div>
        <F
          kind="new"
          name="VelocityStrip mini size='wall' — candidate"
          note="mirrored markup, 9w×24–28h"
        >
          <WallMiniBars reps={reps} />
        </F>
        <div className="r2-panel-label">hero · candidate variant (live hero role)</div>
        <F kind="new" name="HeroVelocityBars — candidate VelocityStrip 'hero' variant">
          <div style={{ height: 240, display: 'flex' }}>
            <HeroVelocityBars velocities={reps} targetReps={LIVE.targetReps} zones={CABLE_ZONES} />
          </div>
        </F>
        <div className="r2-spec-note">
          proposed `detail` density (review columns): current expanded geometry with ~110 px bars —
          not rendered; note-only pending Family-A approval.
        </div>
      </WallPane>
      <ApprovalBlock
        family="Live velocity"
        api="VelocityStrip size?: 'default' | 'wall'  ·  variant: 'full' | 'mini' | 'hero'(new)"
        questions={[
          'mini wall geometry: bars 9 w × 24–28 h px, 2 px gap — approve exact values?',
          "expanded `detail` density for review columns: ~110 px bars (C's set-detail was 118 px) — want it?",
          'hero: adopt as a VelocityStrip variant (structure: full-height bars, top value labels, running-best refline, pending placeholders) or keep as a dashboard-level component?',
          'same WA `zones` bands drive every size (already true in this harness) — confirm.',
        ]}
      />
    </div>
  );
}

function FamilyB({ sim }: { sim: SimState }): React.JSX.Element {
  const ex = SESSION[LIVE.exerciseIndex];
  const tempoProps = {
    activePhase: sim.phase,
    phaseElapsedMs: sim.phaseElapsedMs,
    completed: sim.completed,
    target: {
      concentric: ex.tempoMs.con / 1000,
      hold: ex.tempoMs.hold / 1000,
      eccentric: ex.tempoMs.ecc / 1000,
    },
  };
  return (
    <div className="r2-spec-sheet">
      <PhoneFrame>
        <div className="r2-panel-label">TempoBar · current (live-simulated, real pacing ✓/✗)</div>
        <F kind="real" name="titan:TempoBar">
          <TempoBar {...tempoProps} />
        </F>
      </PhoneFrame>
      <WallPane>
        <div className="r2-panel-label">
          TempoBar size='wall' · candidate (scaled REAL DOM ×1.6)
        </div>
        <F
          kind="new"
          name="TempoBar size='wall' — candidate variant"
          note="scaled real DOM — capabilities identical"
        >
          <WallScale factor={1.6}>
            <TempoBar {...tempoProps} />
          </WallScale>
        </F>
      </WallPane>
      <ApprovalBlock
        family="Tempo"
        api="TempoBar size?: 'default' | 'wall'"
        questions={[
          'wall values: track 20→32 px, labels ~16→26 px effective, pacing-mark glyphs scale with text — approve ×1.6?',
          'implementation: scale design tokens (heights/typography), NOT a CSS transform (keeps hairlines crisp) — the harness transform is prototype-only.',
        ]}
      />
    </div>
  );
}

function FamilyC(): React.JSX.Element {
  const best = Math.max(...SPECIMEN_REPS);
  const liveLoss = Math.round(((best - SPECIMEN_REPS[SPECIMEN_REPS.length - 1]) / best) * 100);
  return (
    <div className="r2-spec-sheet">
      <PhoneFrame>
        <div className="r2-panel-label">FatigueMeter · current density</div>
        <F kind="new" name="FatigueMeter (default)" note="net-new candidate — C's meter">
          <FatigueMeter lossPct={liveLoss} />
        </F>
      </PhoneFrame>
      <WallPane>
        <div className="r2-panel-label">FatigueMeter size='wall' · candidate</div>
        <F kind="new" name="FatigueMeter size='wall' — candidate variant">
          <FatigueMeter lossPct={liveLoss} size="wall" />
        </F>
        <div className="r2-panel-label">StatusPill + aura treatment · three states</div>
        <div className="r2-spec-states">
          {[
            { loss: 5, label: 'quiet' },
            { loss: 22, label: 'threshold · amber flood' },
            { loss: 30, label: 'stop · red flood + cue-flag' },
          ].map((s) => (
            <F key={s.label} kind="new" name={`StatusPill/aura — ${s.label}`}>
              <div
                className={`r2-spec-state${s.loss >= 28 ? ' aura-red' : s.loss >= 20 ? ' aura-amber' : ''}`}
              >
                <StatusPill lossPct={s.loss} repCount={5} />
                <CueFlag lossPct={s.loss} repCount={5} />
              </div>
            </F>
          ))}
        </div>
      </WallPane>
      <ApprovalBlock
        family="Exertion"
        api="FatigueMeter size?: 'default' | 'wall'  (adoption: new titan component)"
        questions={[
          'wall values: track 14→28 px, needle 20→38 px, VL labels 8→13 px — approve?',
          'adopt FatigueMeter into titan (with both sizes) or keep dashboard-local?',
          'aura flood + cue-flag: dashboard-level treatment (proposed — NOT a titan component); trigger thresholds VL20 amber / VL28 red — confirm.',
          'loss reference: running-best (titan v0.5.0 / WA-D01); WA lib impl pending WA-02.05.',
        ]}
      />
    </div>
  );
}

function FamilyD(): React.JSX.Element {
  const ex = SESSION[LIVE.exerciseIndex];
  const elapsed = 30_000;
  const done = LIVE.stream;
  return (
    <div className="r2-spec-sheet">
      <PhoneFrame>
        <div className="r2-panel-label">RestTimer displayOnly · current (bar form)</div>
        <div data-rt-fallback>
          <F kind="real" name="titan:RestTimer" note="displayOnly — v0.5.0">
            <RestTimerCompat
              totalSeconds={LIVE.restSeconds}
              elapsedMs={elapsed}
              onSkip={() => undefined}
              onAddTime={() => undefined}
              nextSetInfo={`Set 5 of ${ex.sets.length} — 8 × ${ex.weight} lbs`}
              visible
              displayOnly
            />
          </F>
        </div>
      </PhoneFrame>
      <WallPane>
        <div className="r2-panel-label">RestRing · candidate variant (C's timer)</div>
        <F kind="new" name="RestRing — candidate titan RestTimer ring variant">
          <RestRing totalSeconds={LIVE.restSeconds} elapsedMs={elapsed} />
        </F>
        <div className="r2-panel-label">composed rest state (verdict + rest-only next set)</div>
        <F kind="mock" name="composed rest snippet">
          <div className="r2-spec-restcomp">
            <span>
              Set 4 verdict: {done.length} reps · mean {formatVelocity(calculateMeanVelocity(done))}{' '}
              m/s · solid work set
            </span>
            <span className="r2-spec-restnext">
              ▶ Next: 8 × {ex.weight} lbs · hold ≥ 0.55 m/s (rest-only rule)
            </span>
          </div>
        </F>
      </WallPane>
      <ApprovalBlock
        family="Rest"
        api="RestTimer variant?: 'bar' | 'ring'  (displayOnly orthogonal, shipped v0.5.0)"
        questions={[
          'ring geometry: 220 px ring, ≥56 px numeral (C parity; current bar numeral is 28 px) — approve?',
          'ring home: titan RestTimer variant vs dashboard-level component?',
          'bar form remains the phone/inline default — confirm the split.',
        ]}
      />
    </div>
  );
}

export function SpecimensView({ sim }: { sim: SimState }): React.JSX.Element {
  const [family, setFamily] = useState<FamilyKey>('A');
  return (
    <div className="r2-specimens">
      <div className="r2-stub-head">
        <Heading level={2}>Specimens · delta-component approval sheets</Heading>
        <span className="r2-stub-tag">per-family approval → one TD ticket each</span>
      </div>
      <div className="r2-spec-chips">
        {FAMILIES.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`r2-spec-chip${family === f.key ? ' on' : ''}`}
            onClick={() => setFamily(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {family === 'A' && <FamilyA />}
      {family === 'B' && <FamilyB sim={sim} />}
      {family === 'C' && <FamilyC />}
      {family === 'D' && <FamilyD />}
    </div>
  );
}
