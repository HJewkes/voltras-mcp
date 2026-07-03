/**
 * Set-log panel — "Sets this session" (VMCP-01.45).
 *
 * Renders the client-side completed-set accumulator as a titan `Table`
 * (# / Weight / Mode / Reps / Peak vel).
 *
 * Note on component choice: titan's `SetRow` organism models a planned-workout
 * set line (fixed SET / PREV / REPS / WEIGHT / RPE columns + velocity-strip
 * overlay). It has no Mode or Peak-velocity column and would render two empty
 * (PREV / RPE) columns here, so the `Table` primitives give true column parity
 * with the legacy set-log while remaining titan components.
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@titan-design/react-ui';
import { PanelCard } from './PanelCard';
import type { SetLogRow } from '../adapter';

export function SetLogPanel({ rows }: { rows: SetLogRow[] }): React.JSX.Element {
  return (
    <PanelCard title="Sets this session">
      {rows.length === 0 ? (
        <div className="panel-empty">No sets yet</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow isHoverable={false}>
              <TableHeaderCell align="left" width={40}>
                #
              </TableHeaderCell>
              <TableHeaderCell align="right">Weight</TableHeaderCell>
              <TableHeaderCell align="right">Mode</TableHeaderCell>
              <TableHeaderCell align="right">Reps</TableHeaderCell>
              <TableHeaderCell align="right">Peak vel</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.index} isHoverable={false}>
                <TableCell align="left" width={40}>
                  {String(row.index)}
                </TableCell>
                <TableCell align="right">{row.weight}</TableCell>
                <TableCell align="right">{row.mode}</TableCell>
                <TableCell align="right">{String(row.reps)}</TableCell>
                <TableCell align="right">{row.peakVelocity}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PanelCard>
  );
}
