import type { Units } from "../types";
import { convertServerText } from "../units";

/** Renders server prose; in kg mode the lb tokens are converted and marked as converted. */
export function ServerText({ text, units, className }: { text: string; units: Units; className?: string }) {
  const parts = convertServerText(text, units);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.convertedFrom ? (
          <abbr key={i} className="converted" title={`Server text said ${part.convertedFrom}`}>
            {part.text}
          </abbr>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}
