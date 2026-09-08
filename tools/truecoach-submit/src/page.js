// The scripts that run inside the page, and the one pure function they share.
//
// Each source below is evaluated as `new Function('payload', SOURCE)`, so it
// must be self-contained: no imports, no closure over this module. That is why
// `applyResult` is stringified into the fill driver instead of being called
// across the boundary — one implementation, exercised by the jsdom test and
// shipped to the browser byte-identical.
//
// Text is read with `textContent`, not `innerText`: TrueCoach puts button
// labels in sr-only spans, where `innerText` comes back empty and any lookup
// built on it silently finds nothing.

import {
  EXERCISE_CARD,
  EXERCISE_PLAN,
  EXERCISE_TITLE,
  RESULTS_TEXTAREA,
  SUBMIT_MARKER,
  WORKOUT_LINK,
} from './selectors.js';

/**
 * Append `block` to a results textarea the way React sees it: the native value
 * setter (React's own descriptor swallows a plain assignment) followed by a
 * bubbling `input` event. Appends to non-empty content, never overwrites.
 */
export function applyResult(el, block) {
  const view = el.ownerDocument.defaultView;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value').set;
  const existing = String(el.value).replace(/\s+$/, '');
  const next = existing === '' ? block : existing + '\n' + block;
  setter.call(el, next);
  el.dispatchEvent(new view.Event('input', { bubbles: true }));
  return next;
}

export const EXTRACT_SLOTS_SOURCE = `
  return Array.from(document.querySelectorAll(${JSON.stringify(EXERCISE_CARD)})).map(
    function (card, index) {
      var title = card.querySelector(${JSON.stringify(EXERCISE_TITLE)});
      var plan = card.querySelector(${JSON.stringify(EXERCISE_PLAN)});
      return {
        index: index,
        title: title ? (title.textContent || '').trim() : '',
        plan: plan ? (plan.textContent || '').trim() : '',
        hasResultsBox: card.querySelector(${JSON.stringify(RESULTS_TEXTAREA)}) !== null,
      };
    },
  );
`;

/**
 * `payload` is `[{ index, block }]`. Every box is resolved before anything is
 * written, so a card that lost its textarea aborts the fill with nothing
 * typed — the no-partial-posts gate, enforced in the page.
 */
export const FILL_SLOTS_SOURCE = `
  ${applyResult.toString()}
  var cards = document.querySelectorAll(${JSON.stringify(EXERCISE_CARD)});
  var targets = [];
  for (var i = 0; i < payload.length; i++) {
    var card = cards[payload[i].index];
    var box = card ? card.querySelector(${JSON.stringify(RESULTS_TEXTAREA)}) : null;
    if (!box) return { filled: 0, missingAt: payload[i].index };
    targets.push({ box: box, block: payload[i].block });
  }
  for (var j = 0; j < targets.length; j++) applyResult(targets[j].box, targets[j].block);
  return { filled: targets.length };
`;

/** `payload` is `{ selector, labels }`. Marks the submit button for clicking. */
export const MARK_SUBMIT_SOURCE = `
  var buttons = Array.from(document.querySelectorAll(payload.selector));
  var found = buttons.find(function (button) {
    return payload.labels.indexOf((button.textContent || '').trim().toLowerCase()) !== -1;
  });
  if (!found) return false;
  found.setAttribute(${JSON.stringify(SUBMIT_MARKER)}, '1');
  return true;
`;

/**
 * `payload` is the long-form date string. Climbs from each workout link to the
 * ancestor that carries the card's date text, and returns every distinct href
 * that matches — the caller refuses anything other than exactly one.
 */
export const FIND_WORKOUT_SOURCE = `
  var links = Array.from(document.querySelectorAll(${JSON.stringify(WORKOUT_LINK)}));
  var hits = [];
  links.forEach(function (link) {
    var node = link;
    for (var depth = 0; depth < 6 && node; depth++) {
      if ((node.textContent || '').indexOf(payload) !== -1) {
        if (hits.indexOf(link.href) === -1) hits.push(link.href);
        return;
      }
      node = node.parentElement;
    }
  });
  return hits;
`;

/** `payload` is the login-signal selector list. */
export const DETECT_LOGIN_SOURCE = `
  return payload.some(function (selector) {
    return document.querySelector(selector) !== null;
  });
`;
