// How far two PNGs disagree, decoded in a browser the caller already holds.
// Shared by `npm run docs:captures` (a baseline mismatch) and `npm run sweep`
// (the contact sheet's "changed since last run" filter).

/**
 * Runs inside the browser (serialised by `page.evaluate`, so self-contained):
 * decode two PNG data URLs and count the pixels they disagree on.
 */
async function comparePixelsInPage([srcA, srcB]) {
  const decode = async (src) => {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  };
  const [x, y] = await Promise.all([decode(srcA), decode(srcB)]);
  if (x.width !== y.width || x.height !== y.height) {
    return { size: `${x.width}x${x.height} vs ${y.width}x${y.height}` };
  }
  const stats = { changed: 0, total: x.width * x.height, maxDelta: 0 };
  const box = { x0: x.width, y0: x.height, x1: -1, y1: -1 };
  for (let i = 0; i < x.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(x.data[i + c] - y.data[i + c]));
    if (delta === 0) continue;
    stats.changed++;
    stats.maxDelta = Math.max(stats.maxDelta, delta);
    const px = (i / 4) % x.width;
    const py = Math.floor(i / 4 / x.width);
    Object.assign(box, {
      x0: Math.min(box.x0, px),
      y0: Math.min(box.y0, py),
      x1: Math.max(box.x1, px),
      y1: Math.max(box.y1, py),
    });
  }
  return { ...stats, box };
}

/**
 * Describe how far two PNGs disagree: changed pixel count, the largest channel
 * delta and the bounding box, decoded in the browser this script already holds.
 */
export async function pixelDiff(browser, a, b) {
  const page = await browser.newPage();
  try {
    const sources = [a, b].map((buf) => `data:image/png;base64,${buf.toString('base64')}`);
    const result = await page.evaluate(comparePixelsInPage, sources).catch(() => null);
    if (result === null) return 'the baseline does not decode as a PNG';
    if (result.size !== undefined) return `size ${result.size}`;
    const { changed, total, maxDelta, box } = result;
    if (changed === 0) return 'encoding only, 0 pixels';
    const pct = ((100 * changed) / total).toFixed(3);
    const extent = `${box.x1 - box.x0 + 1}x${box.y1 - box.y0 + 1} at ${box.x0},${box.y0}`;
    return `${changed} px (${pct}%), max channel delta ${maxDelta}, box ${extent}`;
  } finally {
    await page.close();
  }
}
