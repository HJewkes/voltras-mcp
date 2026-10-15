import type { SessionSet, Units } from "./types";

const KG_PER_LB = 0.4536;

export function toKg(lbs: number): number {
  return Math.round(lbs * KG_PER_LB);
}

export function formatLoad(lbs: number, units: Units): string {
  return units === "kg" ? `${toKg(lbs)} kg` : `${lbs} lb`;
}

export function loadNumber(lbs: number, units: Units): number {
  return units === "kg" ? toKg(lbs) : lbs;
}

/** Weighted sets get converted; damper/band/iso labels pass through untouched. */
export function setLoadLabel(set: SessionSet, units: Units): string {
  return set.weightLbs === null ? set.loadLabel : formatLoad(set.weightLbs, units);
}

export function formatVolume(lbs: number, units: Units): string {
  const value = units === "kg" ? toKg(lbs) : lbs;
  return `${value.toLocaleString("en-US")} ${units}`;
}

const LB_TOKEN = /(\d+(?:\.\d+)?)(?:\s?-\s?(\d+(?:\.\d+)?))?\s?lb\b/g;

export interface TextPart {
  text: string;
  convertedFrom?: string;
}

/**
 * The server writes reasoning in lb. In kg mode each "N lb" or "N-M lb" token
 * becomes an approximate kg token that keeps its original for the close reader.
 */
export function convertServerText(text: string, units: Units): TextPart[] {
  if (units === "lb") return [{ text }];
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(LB_TOKEN)) {
    const at = match.index ?? 0;
    if (at > cursor) parts.push({ text: text.slice(cursor, at) });
    const low = toKg(Number(match[1]));
    const high = match[2] ? toKg(Number(match[2])) : null;
    parts.push({ text: high === null ? `≈${low} kg` : `≈${low}–${high} kg`, convertedFrom: match[0] });
    cursor = at + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}
