/** Server prose is written in lb; in kg mode we label it rather than rewrite words we do not own. */
export function LbTag() {
  return <span className="lb-tag" title="This sentence comes from the server and is always written in pounds">server text in lb</span>
}
