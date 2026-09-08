// The fill script, against a real textarea in jsdom.
//
// `applyResult` is the exact function stringified into the page driver, so
// what passes here is what runs in the browser.

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

import { applyResult, FILL_SLOTS_SOURCE } from '../src/page.js';

let dom;
let box;

beforeEach(() => {
  dom = new JSDOM('<textarea placeholder="Enter results"></textarea>');
  box = dom.window.document.querySelector('textarea');
});

describe('applyResult', () => {
  it('sets the value on an empty box and bubbles an input event', () => {
    // Arrange
    const seen = [];
    dom.window.document.addEventListener('input', (event) => seen.push(event.bubbles));

    // Act
    applyResult(box, '170 lb x 12');

    // Assert
    expect(box.value).toBe('170 lb x 12');
    expect(seen).toEqual([true]);
  });

  it('appends to existing content with a newline instead of overwriting', () => {
    // Arrange
    box.value = 'felt heavy';

    // Act
    applyResult(box, '170 lb x 12');

    // Assert
    expect(box.value).toBe('felt heavy\n170 lb x 12');
  });

  it('does not stack blank lines when the box ends in whitespace', () => {
    // Arrange
    box.value = 'felt heavy\n\n  ';

    // Act
    applyResult(box, '170 lb x 12');

    // Assert
    expect(box.value).toBe('felt heavy\n170 lb x 12');
  });
});

describe('FILL_SLOTS_SOURCE', () => {
  // Compiled inside the window so the script's free `document` is the jsdom one.
  function runDriver(html, payload) {
    const page = new JSDOM(html, { runScripts: 'outside-only' });
    const source = new Function('payload', FILL_SLOTS_SOURCE).toString();
    return { outcome: page.window.eval(`(${source})`)(payload), document: page.window.document };
  }

  const CARD = (title) =>
    `<li class="workoutDisplay-exercise"><h4 data-test="workout-item-title">${title}</h4>` +
    '<textarea placeholder="Enter results"></textarea></li>';

  it('fills every requested card', () => {
    // Arrange
    const html = `<ul>${CARD('Seated Row')}${CARD('Bicep Curl')}</ul>`;

    // Act
    const { outcome, document } = runDriver(html, [
      { index: 0, block: '170 lb x 12' },
      { index: 1, block: '40 lb x 10' },
    ]);

    // Assert
    expect(outcome).toEqual({ filled: 2 });
    expect([...document.querySelectorAll('textarea')].map((el) => el.value)).toEqual([
      '170 lb x 12',
      '40 lb x 10',
    ]);
  });

  it('fills nothing at all when one card has lost its results box', () => {
    // Arrange: the second card is missing its textarea.
    const html = `<ul>${CARD('Seated Row')}<li class="workoutDisplay-exercise"></li></ul>`;

    // Act
    const { outcome, document } = runDriver(html, [
      { index: 0, block: '170 lb x 12' },
      { index: 1, block: '40 lb x 10' },
    ]);

    // Assert
    expect(outcome).toEqual({ filled: 0, missingAt: 1 });
    expect(document.querySelector('textarea').value).toBe('');
  });
});
