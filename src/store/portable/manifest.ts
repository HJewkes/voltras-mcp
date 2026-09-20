// The manifest an export writes and an import and a verify read (VW-534).
//
// It carries NO timestamp, deliberately. Two exports of one unchanged store are
// byte-identical, which is what makes a hash comparison between two runs mean
// something; an "exportedAt" field would make every export differ from every
// other and quietly destroy that.

export const MANIFEST_FILE = 'manifest.json';
export const EXPORT_FORMAT = 'voltras-mcp-store-export/1';

export interface TableManifest {
  readonly name: string;
  readonly file: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly string[];
  /** Left out of the files because SQLite computes them; listed so a reader knows they exist. */
  readonly generatedColumns: readonly string[];
  /** Columns whose values were too large for a JSON number and were written as tagged strings. */
  readonly bigIntegerColumns: readonly string[];
  readonly rowCount: number;
  readonly sha256: string;
}

export interface ExportManifest {
  readonly format: string;
  readonly schemaVersion: number;
  readonly tables: readonly TableManifest[];
  readonly totals: { readonly tables: number; readonly rows: number };
}

export function renderManifest(m: ExportManifest): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

export function parseManifest(text: string, where: string): ExportManifest {
  const parsed = JSON.parse(text) as ExportManifest;
  if (parsed.format !== EXPORT_FORMAT) {
    throw new Error(`${where}: unknown export format ${JSON.stringify(parsed.format)}`);
  }
  if (!Number.isInteger(parsed.schemaVersion) || !Array.isArray(parsed.tables)) {
    throw new Error(`${where}: manifest is missing a schema version or a table list`);
  }
  return parsed;
}
