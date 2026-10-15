import type { ReactNode } from "react";

/** A value that is deliberately missing: dashed frame, a title and the reason. Never a zero. */
export function Absent({ title, reason }: { title: ReactNode; reason?: ReactNode }) {
  return (
    <div className="absent">
      <span className="absent__title">{title}</span>
      {reason && <span className="absent__reason">{reason}</span>}
    </div>
  );
}

/** Inline gap marker for a single missing number inside a sentence or table cell. */
export function Gap({ label = "no data" }: { label?: string }) {
  return <span className="gap" aria-label={label}>— <span className="gap__label">{label}</span></span>;
}
