/**
 * SPEC S7.7 / §15 D13: card facts are page output, so the TS side of the page
 * boundary guards them like any other untrusted field. One module owns the caps
 * (avito, google and yandex all import it), which is why the numbers below are
 * asserted rather than assumed: a change here changes three adapters.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FACT_MAX_CHARS, FACT_MAX_ITEMS, asFacts } from "../../src/extract/facts.ts";

test("S7.7 asFacts keeps the caps in one place", () => {
  assert.equal(FACT_MAX_ITEMS, 4);
  assert.equal(FACT_MAX_CHARS, 60);
});

test("S7.7 asFacts: non-strings and blanks are dropped, whitespace is normalised", () => {
  const facts = asFacts(["  От 4 057,00\u00a0₽ ", "", "   ", 42, null, undefined, { text: "x" }]);
  assert.deepEqual(facts, ["От 4 057,00 ₽"]);
});

test("S7.7 asFacts: a long fact is clipped and the list stops at four", () => {
  const long = "Рейтинг 4,9 из 5, очень длинная подпись, которую карточка не показывает";
  const facts = asFacts([long, "b", "c", "d", "e"]);
  assert.equal(facts.length, FACT_MAX_ITEMS, "a fifth fact is dropped, not glued on");
  assert.equal(facts[0]?.length, FACT_MAX_CHARS);
  assert.deepEqual(facts.slice(1), ["b", "c", "d"]);
});

test("S7.7 asFacts: a non-array payload is no facts, never a throw", () => {
  for (const value of [undefined, null, "От 5 ₽", 7, { 0: "x" }]) {
    assert.deepEqual(asFacts(value), []);
  }
});
