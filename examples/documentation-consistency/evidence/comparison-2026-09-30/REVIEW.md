# Review documentation cases

Status: awaiting independent human review.

Read only this sheet before assigning answers. Do not inspect references or evaluator results.
Use supported when the evidence establishes every claim. Use contradicted for an established contradiction.
Use insufficient when evidence is missing or ambiguous without an established contradiction.
Record the decisive source words, reviewer identity, review date, and any uncertainty.

## doc-01

Evidence:

~~~~text
### Length counting

The length of a string is its number of Unicode code points. Not UTF-8 bytes.
Not UTF-16 code units. Not grapheme clusters.

- An astral-plane character, such as an emoji, counts once. JavaScript
  `String.length` counts two for the same character. A wrapper must not use
  `String.length`.
- A combining mark counts as its own code point. A base character plus a
  combining accent has length two. No normalization merges them.
- The null character U+0000 counts. A wrapper must not treat it as a string
  terminator.
- The empty string has length zero.

| Input (JSON text) | Length | Note |
| --- | --- | --- |
| `""` | 0 | Empty string. |
| `"export worker"` | 13 | Plain ASCII. |
| `"caf\u00e9"` | 4 | Precomposed accent is one code point. Shown as an escape, because the next row shows the same visible text. |
| `"cafe\u0301"` | 5 | Combining accent adds one code point. |
| `"caf\u00e9!"` | 5 | Mixed. |
| `"😀"` | 1 | Emoji is one code point. UTF-16 would count two. |
| `"a😀b"` | 3 | Mixing planes changes nothing. |
| `"a\u0000b"` | 3 | The null character counts. |
~~~~

Candidate:

~~~~text
The length of one string is
its number of Unicode code points: not UTF-8 bytes, not UTF-16 code units,
not grapheme clusters. One emoji counts once. One combining mark counts as
its own code point.
~~~~

Answer: __________

Decisive source words: __________

Reviewer and date: __________

Uncertainty: __________

## doc-02

Evidence:

~~~~text
const STARTER_POLICY: ExplorationStarterPolicy = Object.freeze({
  accept_cutoff: 0.8,
  rejection_cutoff: 0.6,
});
~~~~

Candidate:

~~~~text
**Default starter policy:** `accept_cutoff` 0.8 and `rejection_cutoff` 0.6,
with no confidence floor.
~~~~

Answer: __________

Decisive source words: __________

Reviewer and date: __________

Uncertainty: __________

## doc-03

Evidence:

~~~~text
--mode <shadow|enforcement>
                            Select the run mode. Default: shadow.
~~~~

Candidate:

~~~~text
**Modes:** `shadow` is the default.
~~~~

Answer: __________

Decisive source words: __________

Reviewer and date: __________

Uncertainty: __________

## doc-04

Evidence:

~~~~text
### Length counting

The length of a string is its number of Unicode code points. Not UTF-8 bytes.
Not UTF-16 code units. Not grapheme clusters.

- An astral-plane character, such as an emoji, counts once. JavaScript
  `String.length` counts two for the same character. A wrapper must not use
  `String.length`.
- A combining mark counts as its own code point. A base character plus a
  combining accent has length two. No normalization merges them.
- The null character U+0000 counts. A wrapper must not treat it as a string
  terminator.
- The empty string has length zero.

| Input (JSON text) | Length | Note |
| --- | --- | --- |
| `""` | 0 | Empty string. |
| `"export worker"` | 13 | Plain ASCII. |
| `"caf\u00e9"` | 4 | Precomposed accent is one code point. Shown as an escape, because the next row shows the same visible text. |
| `"cafe\u0301"` | 5 | Combining accent adds one code point. |
| `"caf\u00e9!"` | 5 | Mixed. |
| `"😀"` | 1 | Emoji is one code point. UTF-16 would count two. |
| `"a😀b"` | 3 | Mixing planes changes nothing. |
| `"a\u0000b"` | 3 | The null character counts. |
~~~~

Candidate:

~~~~text
The maxLength rule counts UTF-16 code units. One emoji counts twice.
~~~~

Answer: __________

Decisive source words: __________

Reviewer and date: __________

Uncertainty: __________

## doc-05

Evidence:

~~~~text
const STARTER_POLICY: ExplorationStarterPolicy = Object.freeze({
  accept_cutoff: 0.8,
  rejection_cutoff: 0.6,
});
~~~~

Candidate:

~~~~text
The default starter policy uses accept_cutoff 0.6 and rejection_cutoff 0.8.
~~~~

Answer: __________

Decisive source words: __________

Reviewer and date: __________

Uncertainty: __________

## doc-06

Evidence:

~~~~text
--mode <shadow|enforcement>
~~~~

Candidate:

~~~~text
**Modes:** `shadow` is the default.
~~~~

Answer: __________

Decisive source words: __________

Reviewer and date: __________

Uncertainty: __________
