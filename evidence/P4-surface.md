# P4-D — tool surface audit

Date: 2026-11-06
Verdict: **PASS** (5 tests, 872 → 887/900 chars after P6 added `web_research`)
Command: `node --test tests/unit/tool_surface.test.ts`
Test: `tests/unit/tool_surface.test.ts` (5 tests)

## Declared surface

| Tool | Exposure | Description chars | Cap |
|---|---|---|---|
| `web_search` | direct | 248 | 350 |
| `image_search` | deferred | 249 | 350 |
| `web_read` | deferred | 231 | 350 |
| `web_doctor` | deferred | 144 | 350 |
| **total** | | **872** | **900** |

One direct tool, three deferred. 28 characters of headroom under SPEC §8; any new description must first
free space (the test fails with the per-tool and total figures).

## Schema sizes (recorded, not gated)

`JSON.stringify(tool.parameters)` per tool: `web_search` 777, `web_read` 256, `image_search` 252,
`web_doctor` 84. SPEC §8 says "descriptions + schemas ≤900"; V2.6/V4.5 gate descriptions only. With four
tools the combined figure is far above 900, so the literal reading cannot hold for a multi-tool extension.
Decision recorded for the user: the budget applies to **descriptions** (what the prompt actually pays for a
`direct` tool), while schemas are paid only when a tool is activated (`deferred` tools are not in the prompt
at all). If the strict combined reading is preferred, the `engines` union in `web_search` should shrink first
(it alone is 337 chars).

## Deferred semantics check

`web_search` is `direct`; `web_read`, `image_search`, `web_doctor` are `deferred`, so they are reachable via
tool search / codemode but absent from the default prompt. Verified against the registered list produced by
`createTools()`, which `src/index.ts` registers verbatim — there is no second list that could drift.
