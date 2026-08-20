# Codex review comparison case study

On 2026-07-31, pi-reviewer and standalone `codex review` reviewed two historical snapshots from OnurPi pull request #40. Later commits in the same pull request had already fixed defects in both snapshots, so the comparison could check whether each reviewer found real issues rather than only compare output shape.

## Setup

Both tools reviewed the accumulated change from base commit `85a71d717c9ef57262e706095a6c1296d6a9a7a6` to these snapshots:

- Initial implementation: `494cf9d846e0af1813f0fbe190180567a116ae32`
- Midpoint after four corrective commits: `56447ba3825044ec8b68c837ea28130fb8486f5d`

Both used `gpt-5.6-terra` with high reasoning on the same host. The initial snapshot ran Codex first, then pi-reviewer. The midpoint reversed the order. Each tool ran once per snapshot.

The commands were equivalent to:

```bash
codex review \
  -c 'model="gpt-5.6-terra"' \
  -c 'model_reasoning_effort="high"' \
  --base 85a71d717c9ef57262e706095a6c1296d6a9a7a6

pi-reviewer \
  --model openai-codex/gpt-5.6-terra \
  --thinking high \
  --base 85a71d717c9ef57262e706095a6c1296d6a9a7a6
```

## Wall time

| Snapshot |    Codex review |     pi-reviewer |              pi-reviewer difference |
| -------- | --------------: | --------------: | ----------------------------------: |
| Initial  | 343.161 seconds | 228.837 seconds | 114.324 seconds faster, 33.3% lower |
| Midpoint | 224.454 seconds | 162.414 seconds |  62.040 seconds faster, 27.6% lower |
| Total    | 567.615 seconds | 391.251 seconds | 176.363 seconds faster, 31.1% lower |

Codex took 1.45 times as long across the two snapshots. A retrospective threshold of 60 seconds per review would make both observed differences useful for an interactive command. One run per snapshot provides no run-to-run variance or confidence interval, so this result does not establish a stable speed advantage.

## Findings

### Initial snapshot

Codex reported three P1 findings:

- The Pi Factory lockfile used an SSH URL that broke clean CI installs.
- The login path launched with the invalid `unconfigured` provider.
- Built-in grep and the lack of forced offline mode violated the read-only, no-network boundary.

pi-reviewer reported two P1 findings:

- The same Pi Factory SSH lockfile defect.
- Allowed Git `--output` options could overwrite files in the checkout.

The tools agreed on the lockfile defect. Codex found two valid issue families that pi-reviewer missed. pi-reviewer found one valid repository-write path that Codex missed.

### Midpoint snapshot

Both tools reported the same P1 SSH lockfile defect at the same line. Neither reported the remaining defects fixed by later commits. Those fixes covered configured ripgrep preprocessors, unrelated-base command generation, indirect `find` and `wc` file lists, terminal sanitization, cross-platform path containment, and provenance checks.

## Result

Across the four review runs, Codex produced four finding occurrences and pi-reviewer produced three. Two occurrences matched exactly: the lockfile defect in each snapshot. No reported finding was an obvious false positive when checked against the later fixes and affected code.

The sample shows that both tools can catch the same issue, but their coverage is not equivalent. Codex found more issue families in the initial snapshot, while pi-reviewer uniquely caught a serious write escape. The union of both reports covered more real defects than either report alone.

pi-reviewer was faster in both sampled runs. The small sample supports an observed result, not a general performance claim. Repeated paired runs over more repositories are needed before choosing either tool from speed or defect recall alone.
