# ローカル検証

CodexとOpenCode Goのモデルルーティングを検証するスモークテストを実行します。ここで指定する
`--profile core` / `--profile extended` は検証ランナーの実行モードで、cagentの
Launch Profileとは別に検証範囲を表します。

```bash
# ビルドとLaunch Profileごとのモデル解決だけを確認する（外部CLI起動なし）
bun run validate smoke --profile core

# 特定のエージェントだけを検証する
bun run validate smoke --profile core --agent codex
bun run validate smoke --profile core --agent opencode-go

# 実CLIを起動する（外部モデル呼び出しあり）
bun run validate smoke --profile core --live
```

## Launch Profileとモデルの対応関係

ルーティングマトリクスは `validation/config/matrix.yaml` で管理します。プロファイル名は任意の
文字列ですが、検証用設定ではエージェントごとに次の名前を使います。

| エージェント | Launch Profile |
| --- | --- |
| codex | codex-fast |
| codex | codex-balanced |
| codex | codex-frontier |
| opencode-go | opencode-fast |
| opencode-go | opencode-balanced |
| opencode-go | opencode-frontier |

期待するモデルは、`validation/config/matrix.yaml` の各Launch Profileに対応する
`expected_model`を正本として参照してください。

レポートは既定で `validation/.artifacts/` に生成され、Gitでは管理しません。プロバイダーの
応答から実際のモデルIDを取得しないため、レポートでは
`backend_attestation: unobservable` として明示します。

## Herdr連携（extended）のスモークテスト

`extended`ではdoctor（providerのmodelsチェックを含む）、muxのドライラン、アテステーション検証を非破壊で実行します。既定では
実際のHerdrを起動せず、`herdr pane split/run`を呼びません。既定の対象は
`codex:codex-balanced`です。

```bash
# 既定：ドライラン、doctor（modelsチェックを含む）、アテステーション検証のみ（実Herdr起動なし）
bun run validate smoke --profile extended --attestation /absolute/path/to/attestation.yaml

# 対象エージェントとLaunch Profileを明示
bun run validate smoke --profile extended \
  --agent opencode-go --target opencode-balanced \
  --attestation /absolute/path/to/attestation.yaml
```

実際のHerdrを起動するには、`--live`と`--confirm-herdr-side-effects`の両方が必須です。片方だけ
では起動せず、失敗理由をレポートします。

```bash
# 実Herdr起動（二重承認あり）
bun run validate smoke --profile extended \
  --attestation /absolute/path/to/attestation.yaml \
  --live --confirm-herdr-side-effects
```

アテステーションファイルの例です。プレースホルダーは、対象Launch Profileに対応する
`validation/config/matrix.yaml` の `expected_model` の値に置き換えてください。

```yaml
manual_attestation:
  method: herdr-pane
  verified_by: <GitHubユーザー名>
  verified_at: 2026-07-11T00:00:00+09:00
  expected_model: <matrix.yamlのexpected_modelと一致するモデルID>
  observed_cli_model: <matrix.yamlのexpected_modelと一致するモデルID>
  status: pass
```

### 実Herdr起動の流れ

`--live --confirm-herdr-side-effects`を指定すると、次の流れで実行します。

1. 実行前に作成予定のペイン数、エージェント、Launch Profile、期待モデル、コマンド概要、保持・クリーンアップ方針を表示
2. `herdr pane current`で現在のペインを検出
3. `herdr pane split`で新しいペインを作成（作成直後からペインIDを追跡）
4. `herdr pane run`でコマンドを実行
5. 既定ではペインを**保持**し、`--cleanup-created-panes`指定時だけ今回作成したペインを閉じる

split/run/closeの各ステップの成功・失敗、JSONパースエラー、事前チェックの失敗は
`scores.json`の`herdr_live.steps`に構造化して記録されます。クリーンアップに失敗したペインはIDを
記録したまま失敗として報告し、無断で閉じません。

`method`、確認者、時刻、モデル、`status: pass`は必須です。期待モデルと実測モデルは対象の
ルーティングと一致する必要があります。アテステーションがない場合や不正な場合もレポートを残して失敗
します。生成物、スクリーンショット、生ログはGit管理しません。

extendedの`scores.json`は`automatic_routing`、`manual_attestation`、`herdr_live`
（`live`指定時のみ）、`backend_attestation`を別フィールドで記録します。

## 候補モデルの最小限の品質評価

ルーティング用スモークテストとは別に、候補モデルを評価する `low` / `mid` / `high` 3つの固定フィクスチャを実行できます。
通常実行では、予定の表示と定型成果物の生成だけを行い、モデルは呼び出しません。

```bash
bun run validate evaluate --candidate codex/<candidate-model-id>
```

表示された候補モデル・ベースライン・フィクスチャ・各3試行・予定呼び出し数を確認したうえで、外部CLIを
明示的に指定し、実行を二重に承認してください。

```bash
CAGENT_EVALUATE_COMMAND=/absolute/path/to/evaluator \
  bun run validate evaluate --candidate codex/<candidate-model-id> --execute --confirm-live
```

評価CLIには `--model <model> --case <fixture>` を渡し、標準出力へ回答を返します。
候補モデルとベースラインを、フィクスチャ・試行ごとに交互に実行します。各フィクスチャで候補モデルが3回中
2回以上成功し、重大違反が0件なら合格です。タイムアウト、429、5xx、通信断は1回だけ再試行し、
継続した場合は`inconclusive`とします。

生成される`report.md`、`manifest.yaml`、`scores.json`、`validation/.artifacts/index.md`は
すべて`validation/.artifacts/`配下にあります。生ログ、モデル出力、一時ワークスペースは保存せず、Gitでも
管理しません。
