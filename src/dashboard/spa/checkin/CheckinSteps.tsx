/**
 * The four step screens of the weekly check-in and the stepper above them (VW-896). Pure views:
 * every value and handler comes in as a prop, so each screen renders on its own at either
 * layout. The wall lays the labels out across the top; a phone collapses them to "Step n of 4".
 */
import React from 'react';
import { View } from 'react-native';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  FormField,
  Input,
  Radio,
  RadioGroup,
  StepperStep,
  StepIndicator,
  StepLabel,
  Stepper,
  Surface,
  Typography,
} from '@titan-design/react-ui';

import { ButtonLabel } from '../planner/PanelCard';
import type { MassUnit } from '../live-page/mass.js';
import {
  CHECKIN_STEPS,
  NOTE_MAX_CHARS,
  type CheckinStep,
  type ReviewView,
  type StepError,
} from './checkin-model.js';

export const CARD_MAX_WIDTH = 560;
export const NOT_SAVED_TITLE = 'Not saved: the dashboard server did not answer';

const STEP_LABELS: Record<CheckinStep, string> = {
  bodyweight: 'Bodyweight',
  weekly_checkin: 'Check-in',
  weekly_review: 'Review',
  done: 'Done',
};

export type ReviewResponse = 'accepted' | 'declined' | 'ignored';

const RESPONSE_BUTTONS: readonly { response: ReviewResponse; label: string }[] = [
  { response: 'accepted', label: 'Accept' },
  { response: 'declined', label: 'Decline' },
  { response: 'ignored', label: 'Not now' },
];

export function CheckinStepper(props: { step: CheckinStep; narrow: boolean }): React.JSX.Element {
  const index = CHECKIN_STEPS.indexOf(props.step);
  if (props.narrow) {
    return (
      <Typography variant="caption" color="secondary">
        {`Step ${index + 1} of ${CHECKIN_STEPS.length}`}
      </Typography>
    );
  }
  return (
    <Stepper activeStep={index}>
      {CHECKIN_STEPS.map((step) => (
        <StepperStep key={step}>
          <StepIndicator />
          <StepLabel>{STEP_LABELS[step]}</StepLabel>
        </StepperStep>
      ))}
    </Stepper>
  );
}

/** The card every step sits in: centred and capped on the wall, full width on a phone. */
export function StepCard(props: {
  title: string;
  narrow: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Surface
      level="raised"
      style={{
        width: '100%',
        maxWidth: props.narrow ? undefined : CARD_MAX_WIDTH,
        alignSelf: 'center',
        padding: 24,
        gap: 20,
      }}
    >
      <Typography variant="h3">{props.title}</Typography>
      {props.children}
    </Surface>
  );
}

function Footer(props: { narrow: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <View
      style={{
        flexDirection: props.narrow ? 'column-reverse' : 'row',
        justifyContent: 'flex-end',
        gap: 12,
      }}
    >
      {props.children}
    </View>
  );
}

function PrimaryButton(props: {
  label: string;
  busy: boolean;
  narrow: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Button
      isDisabled={props.busy}
      onPress={props.onPress}
      style={props.narrow ? { width: '100%' } : undefined}
    >
      <ButtonLabel tone="on-solid">{props.label}</ButtonLabel>
    </Button>
  );
}

function SkipButton(props: {
  busy: boolean;
  narrow: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      isDisabled={props.busy}
      onPress={props.onPress}
      style={props.narrow ? { width: '100%' } : undefined}
    >
      <ButtonLabel>Skip</ButtonLabel>
    </Button>
  );
}

/** What a failed post tells the user. `invalid_input` is shown inline by the field instead. */
export function StepErrorAlert(props: {
  error: StepError | null;
  onRetry: () => void;
}): React.JSX.Element | null {
  const { error } = props;
  if (error === null || error.kind === 'invalid_input') return null;
  const retryable = error.kind === 'not_saved' || error.kind === 'indeterminate';
  return (
    <Alert status="error" accessibilityRole="alert">
      <AlertTitle>{errorTitle(error)}</AlertTitle>
      {error.kind === 'refused' && <AlertDescription>{error.code}</AlertDescription>}
      {retryable && (
        <Button variant="outline" onPress={props.onRetry}>
          <ButtonLabel>Retry</ButtonLabel>
        </Button>
      )}
    </Alert>
  );
}

function errorTitle(error: StepError): string {
  switch (error.kind) {
    case 'not_saved':
      return NOT_SAVED_TITLE;
    case 'indeterminate':
      return 'Could not confirm that this was saved';
    default:
      return 'The dashboard refused this step';
  }
}

export interface BodyweightStepProps {
  narrow: boolean;
  unit: MassUnit;
  value: string;
  note: string;
  busy: boolean;
  error: StepError | null;
  /** Shown under the field when the number is outside the usual range. */
  warning: boolean;
  onValue: (value: string) => void;
  onNote: (note: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

export function BodyweightStep(props: BodyweightStepProps): React.JSX.Element {
  const invalid = props.error?.kind === 'invalid_input' ? props.error.message : undefined;
  return (
    <StepCard title="Bodyweight" narrow={props.narrow}>
      <FormField
        label={`Bodyweight (${props.unit})`}
        errorMessage={invalid}
        helperText={
          props.warning ? 'That is outside the usual range. Check the number.' : undefined
        }
      >
        <Input
          aria-label={`Bodyweight in ${props.unit}`}
          keyboardType="decimal-pad"
          value={props.value}
          onChangeText={props.onValue}
        />
      </FormField>
      <FormField label="Note (optional)">
        <Input
          aria-label="Bodyweight note"
          maxLength={NOTE_MAX_CHARS}
          value={props.note}
          onChangeText={props.onNote}
        />
      </FormField>
      <StepErrorAlert error={props.error} onRetry={props.onNext} />
      <Footer narrow={props.narrow}>
        <SkipButton busy={props.busy} narrow={props.narrow} onPress={props.onSkip} />
        <PrimaryButton
          label="Next"
          busy={props.busy}
          narrow={props.narrow}
          onPress={props.onNext}
        />
      </Footer>
    </StepCard>
  );
}

export type CheckinAnswerKey = 'hunger' | 'dietPlanAdherence' | 'sleepQuality';
export type CheckinAnswers = Record<CheckinAnswerKey, string | null>;

const QUESTIONS: readonly { key: CheckinAnswerKey; label: string }[] = [
  { key: 'hunger', label: 'Hunger this week' },
  { key: 'dietPlanAdherence', label: 'Diet plan adherence' },
  { key: 'sleepQuality', label: 'Sleep' },
];
const SCALE = ['low', 'medium', 'high'] as const;

export interface WeeklyCheckinStepProps {
  narrow: boolean;
  answers: CheckinAnswers;
  busy: boolean;
  error: StepError | null;
  onAnswer: (key: CheckinAnswerKey, value: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

export function WeeklyCheckinStep(props: WeeklyCheckinStepProps): React.JSX.Element {
  return (
    <StepCard title="Weekly check-in" narrow={props.narrow}>
      {QUESTIONS.map((question) => (
        <RadioGroup
          key={question.key}
          label={question.label}
          size="lg"
          orientation={props.narrow ? 'vertical' : 'horizontal'}
          value={props.answers[question.key]}
          onChange={(value) => props.onAnswer(question.key, value)}
        >
          {SCALE.map((level) => (
            <Radio key={level} value={level}>
              {level[0].toUpperCase() + level.slice(1)}
            </Radio>
          ))}
        </RadioGroup>
      ))}
      <StepErrorAlert error={props.error} onRetry={props.onNext} />
      <Footer narrow={props.narrow}>
        <SkipButton busy={props.busy} narrow={props.narrow} onPress={props.onSkip} />
        <PrimaryButton
          label="Next"
          busy={props.busy}
          narrow={props.narrow}
          onPress={props.onNext}
        />
      </Footer>
    </StepCard>
  );
}

export interface WeeklyReviewStepProps {
  narrow: boolean;
  /** `null` while the entry call is in flight. */
  view: ReviewView | null;
  busy: boolean;
  error: StepError | null;
  onRespond: (response: ReviewResponse) => void;
  onRetry: () => void;
}

export function WeeklyReviewStep(props: WeeklyReviewStepProps): React.JSX.Element {
  return (
    <StepCard title="Weekly review" narrow={props.narrow}>
      {props.view === null ? (
        <Typography variant="body1" color="secondary">
          Reading this week...
        </Typography>
      ) : (
        <ReviewBody view={props.view} />
      )}
      <StepErrorAlert error={props.error} onRetry={props.onRetry} />
      {props.view?.kind === 'open' && (
        <Footer narrow={props.narrow}>
          {RESPONSE_BUTTONS.map(({ response, label }) => (
            <Button
              key={response}
              variant={response === 'accepted' ? 'solid' : 'outline'}
              isDisabled={props.busy}
              onPress={() => props.onRespond(response)}
              style={props.narrow ? { width: '100%' } : undefined}
            >
              <ButtonLabel tone={response === 'accepted' ? 'on-solid' : 'on-surface'}>
                {label}
              </ButtonLabel>
            </Button>
          ))}
        </Footer>
      )}
    </StepCard>
  );
}

function ReviewBody(props: { view: ReviewView }): React.JSX.Element {
  const { view } = props;
  switch (view.kind) {
    case 'gap':
      return (
        <>
          {view.notes.map((note) => (
            <Typography key={note} variant="body1">
              {note}
            </Typography>
          ))}
        </>
      );
    case 'no_proposal':
      return <Typography variant="body1">No change proposed this week</Typography>;
    case 'answered':
      return <Typography variant="body1">{`Your answer stands: ${view.userResponse}`}</Typography>;
    case 'open':
      return (
        <>
          <Typography variant="body1">{view.advisory}</Typography>
          {view.levers.map((lever) => (
            <Typography key={lever} variant="body2" color="secondary">
              {lever}
            </Typography>
          ))}
        </>
      );
  }
}

export function DoneStep(props: { narrow: boolean; saved: readonly string[] }): React.JSX.Element {
  return (
    <StepCard title="All done" narrow={props.narrow}>
      {props.saved.length === 0 ? (
        <Typography variant="body1">Nothing was saved this time.</Typography>
      ) : (
        props.saved.map((line) => (
          <Typography key={line} variant="body1">
            {line}
          </Typography>
        ))
      )}
      <a href="#/goals" style={{ textDecoration: 'none' }}>
        <Typography variant="button">Back to Goals</Typography>
      </a>
    </StepCard>
  );
}
