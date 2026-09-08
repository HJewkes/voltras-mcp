// One error type for "abandon this entry, keep the run going". Its `code` is
// what the exit report prints, so every abort path names itself the same way.

export class AbortEntry extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'AbortEntry';
    this.code = code;
    this.detail = detail;
  }
}
