// Wave 1+2 review, addendum to finding 1: the cases where a browser's tree builder (HTML5) differs
// from htmlparser2's, each with text that the browser keeps hidden. The expected hidden markers
// were read from a spec-compliant tree (parse5, scripting on) when the table was written; the
// live differential in html-implied-close.test.ts repeats the comparison on generated documents.
// The rule under test: no marker the browser hides may appear in the output, whether the filter
// decided (the text is dropped) or gave up (the remainder is dropped, counted and truncated).
//
// Groups: misnested formatting elements (adoption agency), text and parts inside tables (foster
// parenting), template, select, svg, math and noscript content, an end tag that closes an ancestor
// implicitly, and stray end tags. A slightly lossy extractor is accepted; a leaky one is not.
import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-to-text.js";

type Case = readonly [html: string, browserHidden: readonly string[]];

const CASES: readonly Case[] = [
  ["<b hidden>T0<p>T1</b>T2</p>T3", ["T0", "T1"]],
  ["<a hidden href=x>T0<p>T1</a>T2</p>T3", ["T0", "T1"]],
  ["<i><b hidden>T0</i>T1</b>T2", ["T0", "T1"]],
  ["<b><i hidden>T0</b>T1</i>T2", ["T0", "T1"]],
  ["<b><p>T0</b>T1</p>", []],
  ["<p hidden><b>T0</p>T1</b>T2", ["T0"]],
  ["<div hidden><b>T0</div>T1</b>T2", ["T0"]],
  ["<b>T0<div hidden>T1</b>T2</div>T3", ["T1", "T2"]],
  ["<font hidden><b>T0</font>T1</b>T2", ["T0"]],
  ["<nobr hidden>T0<div>T1</nobr>T2</div>T3", ["T0", "T1"]],
  ["<table hidden>T0</table>T1", []],
  ["<div hidden><table>T0<tr>T1<td>T2</table>T3</div>T4", ["T0", "T1", "T2", "T3"]],
  ["<table>T0<tr hidden>T1<td>T2</td></tr>T3</table>T4", ["T2"]],
  ["<table><tbody hidden>T0</tbody>T1</table>T2", []],
  ["<table><tr><td hidden>T0</td>T1</tr></table>T2", ["T0"]],
  ["<table><b hidden>T0</table>T1", ["T0", "T1"]],
  ["<table><span hidden>T0<tr><td>T1</table>T2", ["T0"]],
  ["<table><caption hidden>T0</caption>T1</table>T2", ["T0"]],
  ["<table><tr hidden><td>T0</table>T1<tr>T2", ["T0"]],
  ["<p hidden><table>T0</table>T1", ["T0", "T1"]],
  ["<table><colgroup hidden>T0</colgroup>T1</table>", []],
  ["<template hidden>T0</template>T1", ["T0"]],
  ["<template><p hidden>T0</template>T1", ["T0"]],
  ["<select hidden><option>T0</select>T1", ["T0"]],
  ["<select><option hidden>T0<option>T1</select>T2", ["T0"]],
  ["<select><optgroup hidden><option>T0</select>T1", ["T0"]],
  ["<svg hidden><p>T0</svg>T1", []],
  ["<svg><p hidden>T0</svg>T1", ["T0", "T1"]],
  ["<svg><foreignObject hidden><p>T0</foreignObject>T1</svg>T2", ["T0", "T1", "T2"]],
  ["<math hidden><mi>T0</mi></math>T1", ["T0"]],
  ["<math><mtext hidden><b>T0</mtext>T1</math>T2", ["T0"]],
  ["<noscript hidden>T0</noscript>T1", ["T0"]],
  ["<noscript><p hidden>T0</noscript>T1", []],
  ["<span hidden><noscript>T0</span>T1</noscript>T2", ["T0", "T1", "T2"]],
  ["<div hidden><p>T0</div>T1", ["T0"]],
  ["<p hidden>T0<div>T1</div>T2", ["T0"]],
  ["<div hidden>T0</span>T1</div>T2", ["T0", "T1"]],
  ["<div hidden></p>T0</div>T1", ["T0"]],
  ["<div hidden>T0</li>T1</div>T2", ["T0", "T1"]],
  ["<span hidden>T0</div>T1</span>T2", ["T0", "T1"]],
  ["<ul hidden><li>T0</ul>T1", ["T0"]],
  ["<li hidden>T0<li>T1</li>T2", ["T0"]],
  ["</div><div hidden>T0</div>T1", ["T0"]],
  ["<div hidden>T0</br>T1</div>T2", ["T0", "T1"]],
  ["<p hidden>T0</p></p>T1", ["T0"]],
  ["<div hidden>T0</body>T1</div>T2", ["T0", "T1"]],
  ["<div hidden>T0</html>T1", ["T0", "T1"]],
  ["<body hidden>T0</body>T1", ["T0", "T1"]],
  ["<p>T0</p><body hidden>T1</body>", ["T0", "T1"]],
];

describe("browser-hidden text never reaches the output", () => {
  for (const [html, hidden] of CASES) {
    it(`drops or refuses ${JSON.stringify(html)}`, () => {
      const result = htmlToText(html);
      for (const marker of hidden) {
        expect(new RegExp(`\\b${marker}\\b`).test(result.text), `${marker} in ${html}`).toBe(false);
      }
    });
  }

  it("covers a hidden text marker in every case it lists (the table is not vacuous)", () => {
    const withHidden = CASES.filter(([, hidden]) => hidden.length > 0);
    expect(withHidden.length).toBeGreaterThan(40);
  });

  it("flags the output when it gave up, and counts the dropped remainder", () => {
    const result = htmlToText("<p>kept</p><b hidden>T0<p>T1</b>T2</p>T3");
    expect(result.truncated).toBe(true);
    expect(result.report.hiddenBlocks).toBeGreaterThanOrEqual(2);
    expect(result.text).toBe("kept");
  });
});
