# code-agent-launcher

[![CI](https://github.com/u7chan/code-agent-launcher/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/u7chan/code-agent-launcher/actions/workflows/ci.yml)
[![Release](https://github.com/u7chan/code-agent-launcher/actions/workflows/release.yml/badge.svg)](https://github.com/u7chan/code-agent-launcher/actions/workflows/release.yml)
[![TypeScript](https://badgen.net/static/TypeScript/5.5%2B/3178C6?icon=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://badgen.net/static/Node.js/%3E%3D18/339933?icon=nodejs)](https://nodejs.org/)
[![Bun](https://badgen.net/static/Bun/1.3.10/000000)](https://bun.sh/)
[![License](https://badgen.net/github/license/u7chan/code-agent-launcher)](LICENSE)

コーディングエージェントを起動するランチャーです。CLIコマンドは `cagent` です。

## Launch Profile

`cagent` は、名前付きのLaunch Profileを使って実行先を決定します。Launch Profileは実行時に必要な
`agent`、`model`、任意の`effort`をまとめたプリセットです。

プロファイル名は任意に付けられます。`reviewer` や `reasoner` という名前を付けても、cagentが
プロンプトの内容からタスクを分類したり、プロファイル名から役割やワークフローを推測したりすることは
ありません。プロファイルはプロンプト、役割、ワークフローを持たない実行用プリセットで、プロンプトはCLI引数
として渡します。

### 最小の有効な設定

設定ファイルは `~/.config/cagent/config.yaml` です。`CAGENT_CONFIG` を設定すると別の
ファイルを指定できます。次の例は、`default_profile`、`profiles`、`agents`に加えて、
実装上必須の `default_agent` と `multiplexer` も含む、最小限の有効な設定です。

```yaml
default_agent: codex
default_profile: worker

agents:
  codex:
    bin: codex
    provider: codex
    model_id_prefix: false
  opencode-go:
    bin: opencode
    provider: opencode-go
    model_id_prefix: true

profiles:
  worker:
    agent: codex
    model: gpt-5.6-terra
  reasoner:
    agent: codex
    model: gpt-5.6-sol
    effort: high
  reviewer:
    agent: opencode-go
    model: deepseek-v4-pro

multiplexer:
  default: herdr
  herdr:
    enabled: true
    start_command_template: "cagent {profile}"
    run_command_template: "cagent run {profile} -- {prompt}"
```

`reviewer` は任意に付けたプロファイル名の例です。プロファイルごとに異なる`agent`を指定できるため、
上の例ではCodexとOpenCode Goを同じ設定で使い分けています。プロファイルの`agent`は
`agents` に定義された名前でなければなりません。

`cagent config init` は、CodexとOpenCode Goのプロファイルを含む既定の設定を作成します。内容を
確認するだけなら `cagent config init --dry-run` を使えます。設定ファイルを作成せずに独自の
プロファイルを定義する場合は、上のYAMLを保存してください。

### 解決の優先順位

プロファイルの選択では、次の順に優先されます。

1. CLIで明示したプロファイル（`cagent reviewer`、`cagent run reviewer -- ...`）
2. `CAGENT_PROFILE`
3. `default_profile`

`cagent mux start <profile>` と `cagent mux run <profile>` は、実装上、プロファイルを位置引数で
必ず指定します。`default_profile` は、プロファイルを省略できる対話実行・非対話実行で使われる
既定値です。`default_profile` を設定しない場合は、プロファイルを明示する必要があります。

選択したプロファイルの値を上書きする場合の優先順位も、CLI、環境変数、プロファイルの順です。

- `model`: `--model` → `CAGENT_MODEL` → `profiles.<name>.model`
- `effort`: `--effort` → `CAGENT_EFFORT` → `profiles.<name>.effort`

プロファイルに`effort`を指定しない場合、`effort`はエージェントCLIに渡されず、エージェント側の設定が使われます。
Codexでは `-c model_reasoning_effort="<effort>"`、OpenCode Goの非対話実行では
`--variant <effort>` に変換されます。OpenCode Goの対話セッションはeffortに対応しない
ため、`effort`付きプロファイルを `mux start` で使うと失敗します。

## CLIの使い方

### 対話実行

引数を省略すると `default_profile` を使います。プロファイルを位置引数で指定することもできます。
対話実行はTTYが必要です。

```bash
# default_profile（worker）で起動
cagent

# reviewerを明示して起動
cagent reviewer
```

### 非対話実行

`run` に渡すプロンプトは `--` の後ろに指定します。プロファイルを省略すると、`CAGENT_PROFILE`、
`default_profile` の順に解決されます。

```bash
# default_profileで1回実行
cagent run -- "READMEを確認して改善点を列挙して"

# reviewerを明示して実行
cagent run reviewer -- "この変更をレビューして"

# モデルとeffortをCLIから上書き
cagent run reasoner --model gpt-5.6-luna --effort high -- "設計上のリスクを整理して"
```

### dry-run

`--dry-run` は解決されたプロファイルと、エージェントを起動せずに実行予定のコマンドを表示します。
`--json` を併用すると `run.plan` のJSONを出力します。

```bash
cagent --dry-run reasoner
cagent run reviewer --dry-run -- "この変更をレビューして"
cagent run reviewer --dry-run --json -- "この変更をレビューして"
```

通常出力では、たとえば `cagent run reasoner --dry-run -- "review design"` のように、
プロファイルの解決結果を先頭に表示します。プロファイルの選択元 (`cli` / `env` / `default`) と、
`--model` / `--effort` / 環境変数で適用された上書きも表示します。表示されるコマンドは
エージェントと`effort`に応じて変わります。

```text
# Resolved profile: reasoner (source: cli)
# Resolved agent: codex
# Resolved model: gpt-5.6-sol
# Resolved effort: high
codex exec --model gpt-5.6-sol -c "model_reasoning_effort=\"high\"" "review design"
```

プロファイルを環境変数や `default_profile` から解決し、CLIで `--effort` を上書きした場合も、
同じ解決結果を表示できます。上書きされた項目は `# Overrides:` に示します。

```bash
CAGENT_PROFILE=reasoner cagent run --dry-run --effort xhigh -- "review design"
```

```text
# Resolved profile: reasoner (source: env)
# Resolved agent: codex
# Resolved model: gpt-5.6-sol
# Resolved effort: xhigh
# Overrides: effort=cli
codex exec --model gpt-5.6-sol -c "model_reasoning_effort=\"xhigh\"" "review design"
```

### Herdr連携

`mux start` は新しいペインで対話セッションを開始し、`mux run` は新しいペインで非対話実行を
開始します。どちらも `<profile>` が必須です。

```bash
# Herdrの新しいペインで対話セッションを開始
cagent mux start reviewer

# Herdrの新しいペインで1回実行
cagent mux run reasoner -- "このIssueを調査して"

# Herdrを起動せず、ペイン操作とエージェントコマンドの計画だけを表示
cagent --dry-run mux run reviewer -- "この変更をレビューして"
```

Herdrのドライランでは次の操作を表示するだけで、`herdr pane current`、`split`、`run`は実際には
呼び出しません。

```text
# Herdr dry-run command sequence:
No Herdr command was invoked.
herdr pane current --current
herdr pane split --pane <current-pane> --direction right --cwd <cwd>
herdr pane run <created-pane> <agent-command>
Pane IDs shown in this plan are placeholders, not resource IDs.
```

通常の `mux start/run` が成功した場合でも、cagentが確認できるのはペインへのエージェントコマンドの
送信までです。コーディングエージェントのタスク完了は追跡しないため、結果の `task_completed` は常に
`false` です。

### 設定・環境の診断

`doctor` は設定ファイル、エージェントの実行ファイル、プロバイダー、`default_profile`、各プロファイルの
`agent` / `model`、マルチプレクサを確認します。`--refresh` を付けるとプロバイダーのモデル一覧を
更新してから確認します。

```bash
cagent doctor
cagent doctor --refresh
cagent doctor --json
```

### プロファイルとモデルの一覧

`cagent list` は設定済みのプロファイルと、その`agent` / `model` / `effort`を表示します。
外部CLIは起動しません。`*` は `default_profile` を示します。

```bash
cagent list
```

```text
PROFILE      AGENT       MODEL          EFFORT
fast         codex       gpt-5.6-luna   -
balanced *   codex       gpt-5.6-terra  -
frontier     codex       gpt-5.6-sol    high

* = default_profile
```

`cagent models` は設定済みモデルの一覧を表示しません。プロファイルの一覧には
`cagent list`、プロバイダーで利用できるモデルの一覧には `cagent models available` を使います。
`cagent models` 単体はエラー終了します。

`models available` はプロバイダーCLIに問い合わせ、現在利用可能なモデルを表示します。
OpenCode Goでは次のコマンドに対応しています。Codexにはプロバイダーのモデル検出アダプターが
ないため、Codexで利用できるモデルは `cagent list` と設定を確認してください。

```bash
CAGENT_AGENT=opencode-go cagent models available
CAGENT_AGENT=opencode-go cagent models available --refresh

# プロバイダーCLIを起動せず、解決されるコマンドだけ確認
CAGENT_AGENT=opencode-go cagent --dry-run models available --refresh
```

## 環境変数

| 環境変数 | 用途 |
| --- | --- |
| `CAGENT_CONFIG` | 設定ファイルのパスを上書き |
| `CAGENT_AGENT` | `models available` と `doctor` の対象エージェントを上書き |
| `CAGENT_PROFILE` | プロファイル選択を上書き |
| `CAGENT_MODEL` | 選択したプロファイルのモデルを上書き |
| `CAGENT_EFFORT` | 選択したプロファイルの`effort`を上書き |

たとえば、環境変数でプロファイルを切り替え、CLIからプロンプトだけを渡せます。

```bash
CAGENT_PROFILE=reviewer cagent run -- "環境変数で選んだプロファイルを使う"
CAGENT_PROFILE=reasoner CAGENT_EFFORT=high cagent run -- "設計を検討する"
```

<details>
<summary>v0.3.xからv1.0.0への手動移行</summary>

v1.0.0では後方互換の読み取りや自動変換を行いません。既存の設定をバックアップし、
プロファイル名、エージェント、モデル、`effort`を手動で移してください。以下の `before` は旧形式を説明する
ためだけの例であり、新しい設定としては使用しないでください。

```yaml
# before: v0.3.x
default_agent: codex
default_level: mid
agents:
  codex:
    bin: codex
    provider: codex
    levels:
      low:
        default_model: gpt-5.6-luna
        models: [gpt-5.6-luna]
        effort: low
      mid:
        default_model: gpt-5.6-terra
        models: [gpt-5.6-terra]
        effort: mid
      high:
        default_model: gpt-5.6-sol
        models: [gpt-5.6-sol]
        effort: high
```

```yaml
# after: v1.0.0
default_agent: codex
default_profile: reasoner
agents:
  codex:
    bin: codex
    provider: codex
    model_id_prefix: false

profiles:
  reasoner:
    agent: codex
    model: gpt-5.6-sol
    effort: high

multiplexer:
  default: herdr
  herdr:
    enabled: true
```

移行する際は、実行用途ごとに任意のプロファイル名を付け、旧形式のモデル設定を
`profiles.<name>.model`へ移します。共通の既定値は `default_profile` に設定し、実行ごとに
別のプロファイルを使う場合はCLIまたは `CAGENT_PROFILE` で明示します。旧形式の環境変数やCLI
指定は自動変換されないため、上記の新しいプロファイル選択と上書き規則に合わせて手動で置き換えて
ください。

</details>

## Linuxへのインストール

スタンドアロンリリースでは、Linux glibc向けのx64とarm64を提供します。WSL2のUbuntuなど、
glibcベースのLinuxディストリビューションでも同じ手順を使用できます。GitHubのReleasesページで
バージョンを確認し、アーキテクチャに合うアーカイブをダウンロードしてください。`curl`、`tar`、
GNU `sha256sum`を使用します。

```bash
VERSION=0.1.0
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

curl --fail --location --remote-name \
  "https://github.com/u7chan/code-agent-launcher/releases/download/v${VERSION}/cagent-v${VERSION}-linux-${ARCH}.tar.gz"
curl --fail --location --remote-name \
  "https://github.com/u7chan/code-agent-launcher/releases/download/v${VERSION}/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS

tar -xzf "cagent-v${VERSION}-linux-${ARCH}.tar.gz"
mkdir -p "$HOME/.local/bin"
install -m 0755 "cagent-v${VERSION}-linux-${ARCH}/cagent" "$HOME/.local/bin/cagent"
"$HOME/.local/bin/cagent" --version
```

`$HOME/.local/bin` が `PATH` に含まれない場合は、シェルの設定に追加してください。システム全体に
インストールする場合は、配置先を`/usr/local/bin/cagent`へ変更し、必要な権限を使用します。

### 更新

新しいバージョンとアーキテクチャを指定し、上記のダウンロード、チェックサム検証、展開を繰り返します。
最後に `install -m 0755` で既存のバイナリを置き換えます。検証前に既存のバイナリを削除しないで
ください。設定は`~/.config/cagent/config.yaml`にあり、バイナリを更新しても変更されません。

### リリースの完全性とアテステーション

`SHA256SUMS`はダウンロード時の破損とアセットの取り違えを検出します。さらにGitHub CLIを使って、
Immutable Release由来のリリースアテステーションと、リリースワークフローが生成したビルドプロベナンスを
検証できます。これらのサブコマンドを含む最新版のGitHub CLIをインストールし、`gh auth login`を
済ませてください。使用中のCLIが対応しているかは、`gh release verify --help`と
`gh attestation verify --help`で確認できます。

```bash
VERSION=0.1.0
TAG="v${VERSION}"
ARCH=x64 # arm64の場合はarm64へ変更
ASSET="cagent-${TAG}-linux-${ARCH}.tar.gz"
REPOSITORY=u7chan/code-agent-launcher

gh release verify "$TAG" --repo "$REPOSITORY"
gh release verify-asset "$TAG" "$ASSET" --repo "$REPOSITORY"
gh attestation verify "$ASSET" \
  --repo "$REPOSITORY" \
  --source-ref "refs/tags/$TAG" \
  --signer-workflow "$REPOSITORY/.github/workflows/release.yml"
```

チェックサム、リリースの完全性、アテステーションのいずれかの検証に失敗したアセットは実行せず、
ダウンロード元、バージョン、アーキテクチャを確認してください。`SHA256SUMS`にダウンロードした
アーカイブ名が含まれることも確認します。

### アンインストール

```bash
rm "$HOME/.local/bin/cagent"
```

システム全体に配置した場合は、実際の配置先から削除します。設定も不要であれば
`~/.config/cagent/`を別途削除できますが、再インストールに備えて残しても問題ありません。

### サポート範囲

- 対象: Linux glibc x64、Linux glibc arm64、これらの環境を提供するWSL2
- 対象外: macOSネイティブ、Windowsネイティブ、muslベースのディストリビューション、上記以外のアーキテクチャ
- ソースからの開発実行: Node.js 18+とBunを使用する本READMEの開発手順に従う

## ローカル検証

CodexとOpenCode Goのモデルルーティング検証は [`validation/`](validation/) で管理します。
ここで指定する `--profile core` と `--profile extended` は検証ランナーの実行モードであり、
cagentのLaunch Profileとは別の指定です。

```bash
# ビルドとLaunch Profileごとのモデル解決を確認（外部CLIは起動しない）
bun run validate smoke --profile core

# CodexとOpenCode GoのCLIを実際に起動（外部モデル呼び出しあり）
bun run validate smoke --profile core --live
```

ルーティングmatrixは `codex-fast`、`codex-balanced`、`codex-frontier` と、それらに対応する
OpenCode Goのプロファイルで構成されています。実行結果は `validation/.artifacts/` に保存され、
Gitでは管理しません。`--live` は外部モデルを呼び出すため、明示的な依頼または確認がある場合
だけ実行してください。

## リリース前の検証

リリースに関するGitHubリポジトリの保護設定と、失敗時の復旧方針は
[`docs/releasing.md`](docs/releasing.md) を参照してください。メンテナーがバージョン更新PRまたは
リリースを開始するときは [`.agents/skills/github-release/SKILL.md`](.agents/skills/github-release/SKILL.md)
を使用します。

通常のCIはBun 1.3.10を使い、Linux x64向けスタンドアロンのビルド・パッケージ化、アーカイブ構造、
SHA-256チェックサム、隔離環境でのスモークテストを検証します。ローカルではLinux x64環境で同じ検証を
次のコマンドから実行できます。

```bash
bun run release:check
```

スモークテストはリポジトリ外の一時ディレクトリで `cagent --version`、`cagent --help`、一時的な
`CAGENT_CONFIG`を使う `cagent config init` を実行します。生成された既定設定の
`default_profile`を使ったドライランも確認し、実行ディレクトリの`.env`と`bunfig.toml`が環境変数や
preloadを注入しないことも検証します。

指定した安定版SemVerタグ、`package.json`のバージョン、および生成済みアーカイブを検証する場合は
次のコマンドを使用します。アーカイブは展開せず、エントリ一覧を検査します。

```bash
bun run release:validate -- --tag v0.1.0
bun run release:validate -- --tag v0.1.0 \
  --archive release/cagent-v0.1.0-linux-x64.tar.gz --arch x64
```

チェックサム処理は、後続のリリースワークフローから次の形で再利用できます。

```bash
bun run release:checksum -- generate release/SHA256SUMS release/*.tar.gz
bun run release:checksum -- verify release/SHA256SUMS release
```

## スタンドアロンリリースアーティファクト

`bun run build:standalone`は、Linux glibc x64ベースラインとarm64向けのスタンドアロンアーカイブを
`release/`に生成します。各アーカイブは次の固定構造です。

```text
cagent-vX.Y.Z-linux-<arch>/
  cagent
  README.md
  LICENSE
```

アーカイブは固定のファイル順、更新時刻、所有者/グループ、gzipのタイムスタンプで生成します。同じ入力と固定した
Bunツールチェーンではアーカイブの再現性を確認できます。一方、Bunスタンドアロンバイナリ自体の
バイト単位の再現性は保証対象ではありません。
