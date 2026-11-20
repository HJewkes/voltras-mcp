import React from 'react';
import {
  InfoIcon,
  TipTrigger,
  Typography,
  useOnSurfaceColor,
  type TypographyVariant,
} from '@titan-design/react-ui';

import { SPACE } from '../design';

/**
 * A short visible label with its explanation behind a tip. titan's design floor
 * keeps explanatory sentences off the page, so every `*Tip` fragment and every
 * line of server prose on this page reaches the lifter through one of these.
 */
export function TipLabel(props: {
  label: string;
  tip: string;
  variant?: TypographyVariant;
}): React.JSX.Element {
  const ink = useOnSurfaceColor('secondary');
  return (
    <TipTrigger label={props.label} content={<Typography variant="body2">{props.tip}</Typography>}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.xxs }}>
        <Typography variant={props.variant ?? 'body2'} color="secondary">
          {props.label}
        </Typography>
        <InfoIcon size={14} color={ink} />
      </div>
    </TipTrigger>
  );
}
