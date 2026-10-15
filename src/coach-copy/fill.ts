// Slot filling for the `{{token}}` fragments. Pure, so the dashboard SPA can import it.

/** Fills each `{{token}}` once; a filled value is never scanned for further tokens. */
export function fillSlots(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => {
    const value = values[token];
    if (value === undefined) {
      throw new Error(`coach copy: template placeholder "${token}" has no value`);
    }
    return value;
  });
}
