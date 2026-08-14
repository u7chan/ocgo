---
name: validate-code-agent-launcher
description: Run the repository-local validation workflow for code-agent-launcher. Use when asked to validate cagent routing, build the local CLI, run the Codex or OpenCode smoke test, collect a validation report, or prepare a validation PR.
---

# Validate Code Agent Launcher

Run the deterministic validation runner. Do not reimplement its build, model-resolution, or report logic in prompts.

## Smoke

1. Inspect the worktree and explain existing changes before validation.
2. Run `bun run validate smoke --profile core` to build `dist/index.js` and verify routing for Codex and OpenCode Go.
3. Use `--agent codex` or `--agent opencode-go` to run only one agent.
4. Before an external model call, state that `--live` starts three Launch Profiles for each selected agent, or list the specific agent if `--agent` is used.
5. Run `bun run validate smoke --profile core --live` only after the user explicitly requests live validation or confirms the planned calls.
6. Report the generated directory below `validation/.artifacts/` and distinguish routing from backend attestation.

The routing matrix is fixed in `validation/config/matrix.yaml`:

| Agent | Launch Profile | Expected model |
| --- | --- | --- |
| codex | codex-fast | gpt-5.6-luna |
| codex | codex-balanced | gpt-5.6-terra |
| codex | codex-frontier | gpt-5.6-sol |
| opencode-go | opencode-fast | opencode-go/deepseek-v4-flash |
| opencode-go | opencode-balanced | opencode-go/deepseek-v4-pro |
| opencode-go | opencode-frontier | opencode-go/kimi-k2.7-code |

Treat `backend_attestation: unobservable` as an unknown state, not a successful provider-side model verification.

## Candidate evaluation

`bun run validate evaluate --candidate <agent/model>` は候補・baseline・3つの固定fixture・3試行・予定呼び出し数を表示し、modelを起動しない。実評価はユーザーが明示承認した場合のみ、`--execute --confirm-live` と `CAGENT_EVALUATE_COMMAND` を指定して行う。予定は18呼び出し（3fixture × candidate/baseline × 3試行）であることを事前に伝える。

評価はfixtureごとにcandidate/baselineを交互実行し、candidateが各fixtureで2/3成功、かつ重大違反ゼロの場合だけpassとする。timeout、429、5xx、通信断は1回再試行し、続けばinconclusiveとして扱う。`validation/.artifacts/` のreport、manifest、scores、index以外に生ログ・全出力・一時workspaceを保存またはコミットしない。

## Herdr extended smoke

`bun run validate smoke --profile extended --attestation <absolute-path>` は既定で dry-run、doctor（providerのmodelsチェックを含む）、mux dry-run、attestation検証のみを実行し、実Herdrを起動しません。既定の対象Launch Profileは `codex-balanced` です。実Herdr paneの起動には `--live` と `--confirm-herdr-side-effects` の両方が必須です。片方だけでは一切 split/run/close を呼ばず、失敗理由をレポートします。

```bash
# 既定：実Herdr起動なし
bun run validate smoke --profile extended --attestation /absolute/path/to/attestation.yaml

# 対象agentとLaunch Profileを明示
bun run validate smoke --profile extended \
  --agent opencode-go --target opencode-balanced \
  --attestation /absolute/path/to/attestation.yaml

# 実Herdr起動（二重承認あり）
bun run validate smoke --profile extended \
  --attestation /absolute/path/to/attestation.yaml \
  --live --confirm-herdr-side-effects
```

live前には予定pane数、agent、Launch Profile、expected model、コマンド概要、保持/cleanup方針を表示する。split成功直後から作成pane IDを追跡し、run失敗でもIDを失わない。既定はpane保持。`--cleanup-created-panes`指定時のみ今回作成したpaneをcloseし、cleanup失敗時はIDを保持してfail報告する。current/split/run/cleanupの各結果は `scores.json` の `herdr_live.steps` に構造化記録される。

レポートでは `automatic_routing`、`manual_attestation`、`backend_attestation` を混同せずに報告する。attestation、スクリーンショット、生ログ、`validation/.artifacts/` はコミットしない。

## Wiki

検証完了後、結果を永続化するには `validation-log-update` スキルを使う。GitHub Wikiの `Validation-Log.md` にエントリを追記する。

## Validation PRs

When asked for a validation PR, require a clean worktree before the formal run. Commit the tested change first, run validation, then commit the report separately. Do not commit files below `validation/.artifacts/`.
