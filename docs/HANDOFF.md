# 引き渡しガイド: WikiSkill 実験結果の最終スコア付けと外部 AI との比較

> **🚧 作成中のプロジェクトです。** 本書の内容は `schema_version: 1` の時点のものです。ファイル形式の変更ルールは
> [10. バージョンと変更ルール](#10-バージョンと変更ルール) にあります。免責は [README](../README.md#copyright-and-disclaimer) のとおりです。
> 本書は、WikiSkill を知らないチームが読んで作業できるかを、実際にその立場で試して(ブリッジによる利用者テスト)改訂しています。

**対象読者**: 最終的なスコア付けと、外部 AI との比較を担当するチーム。WikiSkill 自体の知識は前提にしません。

---

## 0. 先に読む要点

1. 渡すのは **1回の実験(run)の成果物一式** です。点数だけでなく、**全回答・全出力・エージェントが見たプロンプトの原文・課題と正解** を含みます。したがって、**採点方法を変えても、エージェントを再実行せずに再採点できます**(`wikiskill rescore`)。
2. 比較の中心は `results/predictions.jsonl` です。1行 = 「ある課題を、ある条件(スキルなし/進化後など)で解いた1回の結果」です。
3. 保持済みテスト分割(`test`)は、進化の途中では一度も使っていません。`wikiskill check` が、**確認できる範囲で**機械的に確かめます([8](#8-保証と非保証) に、確認できないことも書いています)。
4. 外部 AI と比べる場合は、**同じ課題・同じプロンプト・同じ回答形式・同じ採点器** にそろえてください([7](#7-外部-ai-との比較手順))。**何と何を比べるかで、結論の意味が変わります**([7.1](#71-何と何を比べるか))。
5. 受け取ったら最初に **`wikiskill check --run <dir>`** を実行してください。
6. **`correct` は暫定です。** 正式な採点基準は、受け取るチームが決めてかまいません(送り元に別の正式基準はありません)。

## 1. 責任の分担

| | WikiSkill 側(渡す側) | 受け取るチーム |
|---|---|---|
| 課題の分割(train / val / test) | `splits.json` と `tasks.jsonl` に固定して渡す | 変更しない |
| スキルの進化 | 実行済み。最終スキルは `skills/` に固定 | **やり直さない**(テスト結果を見てからの再進化は、テストを訓練に使うのと同じです) |
| 最終スコア付け | 暫定の採点結果を `correct` に保存 | **正式な採点はこちら**(`rescore`) |
| 外部 AI との比較 | `eval` / `rescore` の仕組みと本書を提供 | 実施・結論づけ |
| 結果の解釈 | 保証と制約を [8](#8-保証と非保証)・[9](#9-既知の制約と注意) に記載 | 本書の制約を踏まえて解釈 |
| `output` の再配布の可否 | 判断は送り元の責任者 | 再配布する前に送り元へ確認 |

## 2. 受け取ったらまずやること

**前提**: Node 22 以上。`check` と `rescore` に `claude` CLI は不要で、LLM も呼びません。

```sh
git clone https://github.com/HalkPapa/WikiSkill && cd WikiSkill
git checkout <manifest.json の environment.tool.git_commit>   # 成果物を作ったコード
npm install && npm run build
node dist/src/cli.js check --run <成果物のディレクトリ>
```

`OK` と表示され、`problem:` が出なければ、次を満たしています。

- run が `completed` で終わっている(途中停止や失敗ではない)
- `predictions.jsonl`・`tasks.jsonl`・`splits.json` が、完了時に記録されたハッシュ(SHA-256)と一致する(**完了後に書き換えられていない**)
- `tasks.jsonl`・`splits.json`・`predictions.jsonl` が互いに矛盾しない。どの課題も train / val / test のどれか1つだけに属する
- テスト課題が、進化の途中(ゲートの検証や訓練トレース)に使われた痕跡がない。テスト行の書き込み時刻が、すべてのゲート行より後である
- テストの `no-skills` と `evolved` が、全課題について**ちょうど1行ずつ**ある
- 参照されるプロンプト全件が `results/prompts/` にあり、ハッシュが名前と一致する
- `skills/` の内容が、`manifest.json` のハッシュと一致する(どのスキルが違うかも表示されます)
- **エージェントや外部採点コマンドの呼び出しが失敗していない**(`manifest.json` の `quality`、行の `error`)。失敗は「不正解」ではなく環境の障害なので、1回だけ再試行したうえで、残った失敗は記録され、その run は `FAIL` になります。大半が失敗した場合、run は途中で止まります(`status: failed`)

練習用に、実際の run を1つ同梱しています: [`examples/reference-run/`](../examples/reference-run/)(`node dist/src/cli.js check --run examples/reference-run`)。

終了コードは、`OK` が 0、`FAIL` が 1 です。複数回実行(`--runs N`)の場合は、親ディレクトリを渡すと `run-1`, `run-2`, … を順に検査します。`FAIL` の run は使わず、送り元に連絡してください。

`note:` の見方:
- `git_dirty`: 成果物を作ったとき、コードに未コミットの変更がありました。その場合、コミットだけではコードを再現できません。変更は `results/code.diff`(`git diff HEAD`)に保存されています(新規の未追跡ファイルは含まれません)。
- `no test split`: テスト分割がなく、保持済みデータでの比較はできません。

## 3. 成果物の構成

```
<run のディレクトリ>/
├── manifest.json            何が・どの環境で・どの設定で作ったか(4 参照)
├── tasks.jsonl              課題の一覧: id・input・expected・split(train/val/test)
├── splits.json              課題ID → train / val / test の割り当て
├── report.json              暫定の集計(検証・テストの正解率、ブートストラップ結果)
├── results/
│   ├── predictions.jsonl    ★ 比較の中心。1行 = 1回の試行(4 参照)
│   ├── prompts/<sha256>.txt エージェントが見たシステムプロンプトの原文(ハッシュで参照)
│   └── code.diff            (git_dirty のときだけ)成果物を作ったコードの未コミットの差分
├── skills/<名前>/           ★ 最終スキル(SKILL.md / PURPOSE.md / 同梱ファイル)
├── raw/iter-NN/<課題>.json  訓練課題の実行トレース(テスト課題は含まれない)
└── wiki/                    進化の途中の知識(patterns/・index.md・logs.md・skill-impact.md)
```

`--runs N`(N>1)の場合は、親ディレクトリの下に `run-1/`, `run-2/`, … が並び、それぞれが上の構成を持ちます。親の `report.json` には平均が入ります。

比較に必要なのは `results/`、`tasks.jsonl`、`splits.json`、`skills/`、`manifest.json` です。

**`raw/` と `wiki/` は内部資料です。** 形式は契約の対象外で(`raw/` のキーは camelCase で、`predictions.jsonl` の snake_case とは違います)、予告なく変わることがあります。`wiki/` の文章は **LLM が書いたもの** で、事実と食い違うことがあります(たとえば、ログの件数が実際の集計とずれる、`Rationale` が空、など)。採点や結論の根拠にしないでください。

## 4. `results/predictions.jsonl` の仕様

1行が1つの JSON オブジェクトです(JSON Schema: [`schema/prediction-row.schema.json`](schema/prediction-row.schema.json))。

| フィールド | 型 | 意味 |
|---|---|---|
| `schema_version` | 整数 | 形式のバージョン(現在 `1`) |
| `run` | 文字列 | `run-1`, `run-2`, … 。`eval` では指定した名前 |
| `split` | 文字列 | `val` または `test`(`eval` では指定した分割) |
| `condition` | 文字列 | 何が答えたか(下表) |
| `iteration` | 整数 | `candidate:` の行ではゲートの反復番号、`resumed-skills` の行では続行を始めた時点の反復番号。それ以外は `0` |
| `task_id` | 文字列 | 課題ID(`splits.json`・`tasks.jsonl` と対応) |
| `input` | 文字列 | エージェントに渡した課題文 |
| `expected` | 文字列 | 正解 |
| `answer` | 文字列 / null | 出力から抽出した回答。見つからなければ `null`(不正解扱い)。再採点では、`null` の行は `output` から取り直します |
| `correct` | 真偽 | 暫定の採点結果(再採点で上書き可能。元の値は `correct_original` に残る) |
| `scorer` | 文字列 | 暫定の採点器: `exact` / `contains` / `custom` |
| `system_prompt_sha256` | 文字列 | エージェントが見たシステムプロンプトの SHA-256。原文は `results/prompts/<値>.txt` |
| `output` | 文字列 | 実行ログ全文(下記) |
| `model` | 文字列(任意) | 答えを出したモデルの正確なID(例: `claude-haiku-4-5-20251001`)。外部の行にはない |
| `created_at` | 文字列(任意) | 行を書いた時刻(ISO 8601) |
| `error` | 文字列(任意) | エージェントの呼び出し自体が失敗した(1回の再試行後も)。`correct` は `false` だが**本当の判定ではない**。この行を含む run は `check` が `FAIL` にする |

### `output` の書式
行頭のマーカーで区切られます: `[thinking]`(推論)、`[assistant]`(途中の発言)、`[tool_use]`(ツール呼び出し)、`[tool_result]`(ツールの出力)、最後に `[final] ` と最終返答。`[assistant]` の内容は、最終返答と重なることがあります。**最終返答 = 最後の `[final] ` 以降のテキスト** です。

**外部 AI の行の `output` には、マーカーは不要です。** 返答の全文をそのまま入れてください(全体が最終返答として扱われます)。

### `condition` の値

| 値 | 意味 | 比較に使うか |
|---|---|---|
| `no-skills` | スキルなし。**同じモデル・同じハーネス**でスキルだけ外したもの | ✅ 基準(ベースライン) |
| `evolved` | 最終スキル(`skills/`)を使ったもの | ✅ 評価対象 |
| `candidate:<スキル名>@iter<k>` | 進化中のゲート判定のための検証(`val`)の試行 | ❌ 簿記用(要約から除外される) |
| `resumed-skills` | 続きから実行したとき、開始時点のスキルの検証 | ❌ 簿記用 |
| 任意の名前 | `eval` で評価したスキルセットの名前、または外部 AI の行(`external:<名前>` を推奨) | ✅ |

`val` には `evolved` の行がありません(検証でのスコアは、採用されたゲート行か、`report.json` の `best_val` にあります)。

### どのプロンプトがどの条件のものか
`predictions.jsonl` の行の `system_prompt_sha256` から引きます。`no-skills` は全 run で同一のプロンプトです。`evolved` のプロンプトは、**run ごとに違います**(スキルが run ごとに違うため)。

### 例(1行。見やすく整形)

```json
{"schema_version":1,"run":"run-1","split":"test","condition":"evolved","iteration":0,
 "task_id":"x1","input":"Generate the internal member ID for: Liam Murphy, born 1988.",
 "expected":"MUR88L","answer":"MUR88L","correct":true,"scorer":"exact",
 "system_prompt_sha256":"3f1c…","model":"claude-haiku-4-5-20251001","created_at":"2026-10-12T05:00:00.000Z",
 "output":"[thinking] …\n[final] <answer>MUR88L</answer>"}
```

サンプルファイル: [`examples/predictions.sample.jsonl`](examples/predictions.sample.jsonl)(合成データ。形式の確認用です)。

### その他のファイル

- **`tasks.jsonl`**: 1行1課題 `{"id","input","expected","split"}`。元の課題ファイルはここに同梱されています。課題ごとの添付ファイル(`workspace`)は含まれません(使った run では、manifest の `environment.tasks_file` に元のパスとハッシュがあります)。
- **`splits.json`**: `{"schema_version":1,"train":[…],"val":[…],"test":[…]}`。課題IDの一覧です。
- **`manifest.json`**([`schema/manifest.schema.json`](schema/manifest.schema.json)):
  - `status`(`completed` 以外の run は使わない)、開始・終了時刻、失敗時の `error`
  - `environment`: コードのバージョンと git コミット、Node と `claude` CLI のバージョン、モデル名(`models.task_agent` は指定した別名で、正確なIDは各行の `model`)、課題ファイルのパスと SHA-256、外部採点コマンド、`agent_invocation`(エージェントの起動方法。[7.2](#72-公平な比較のためのチェックリスト) 参照)
  - `options`: 反復回数、採点器、分割比率、並列数、エージェントのツール、wiki の可視性など
  - `skills`: 最終スキル名と、スキルごと/全体の SHA-256
  - `files_sha256`: 完了時の `predictions.jsonl`・`tasks.jsonl`・`splits.json` のハッシュ
  - `quality`: `agent_errors`(失敗したエージェント呼び出しの数)と `grader_failures`(失敗した外部採点の数)。どちらも 0 でなければ使えません
  - 続きから実行した run だけ: `first_started_at`(最初の開始時刻。`started_at` は最新のセッション)、`resumed_from_iteration`
  - `guarantees`: [8](#8-保証と非保証) の申告
- **`report.json`**: 暫定の集計。**正式な数値は `predictions.jsonl` から再計算してください。** キーは snake_case です。

## 5. 採点の仕様(暫定の採点が何をしているか)

### 回答の抽出
次の順に探し、最初に見つかったものを回答とします(前後の空白は除きます)。

1. **最終返答**(最後の `[final] ` 以降。マーカーがなければ全体)にある、**最後の** `<answer>…</answer>`(大文字小文字は区別しない)
2. 最終返答にある、**行頭が** `ANSWER:` で始まる最後の行(`[final] ANSWER: x` のようにマーカーと同じ行にあっても、マーカーを除いた後の行頭なので有効です)
3. 実行ログ全体にある、最後の `<answer>…</answer>`
4. 実行ログ全体にある、行頭が `ANSWER:` の最後の行

どれもなければ `answer` は `null` で、**不正解** です。推論(`[thinking]`)の中に `<answer>` が出てきても、最終返答に回答があればそちらが優先されます。

### 組み込みの採点器
どちらも、比較前に回答と正解を次のとおり正規化します: 前後の空白を除く → 小文字にする → 連続する空白を1つにする → 末尾の `.` または `。` を1つ除く。

- `exact`: 正規化後に **完全一致**
- `contains`: 正規化後の回答に、正規化後の正解が **含まれる**

### 外部の採点コマンド(`custom`)
独自の採点器を使う場合のインターフェースです。コマンドは `sh -c` で、**`rescore` を実行したディレクトリで、1回答につき1回** 実行されます(並列実行されます)。

- **標準入力**: 1つの JSON `{"id","input","expected","answer","output","workspace"}`
  - `answer` は `null` のことがあります。`output` は実行ログ全文です。
  - `workspace` は、`evolve` / `eval` の実行中だけ、エージェントの作業ディレクトリ(出力ファイルを含む)を指します。**`rescore` では常に `null`** で、環境変数 `WIKISKILL_WORKSPACE` も設定されません。したがって、作業ファイルを見ないと採点できない課題(表計算の出力比較など)は、`rescore` では再採点できません。その場合は、実行時の `correct` をそのまま使ってください。
- **標準出力**: 次のどれか。
  - `true` / `false` / `1` / `0`
  - `{"correct": true}` / `{"correct": false}`
  - `{"score": <数値>}`(1 以上が正解、未満は不正解)
- **それ以外の出力**(`maybe`、`2`、`"true"`(文字列)、`true extra` など)、終了コードが 0 以外、コマンドが存在しない、60 秒を超えた、は **不正解として扱い、行ごとに警告を出し**、`rescore` の終了コードが 1 になります。最後に「N 行が採点できなかった」とまとめて表示されます。タイムアウトではシェルの子プロセスもまとめて停止します。
- コマンドは、実行するマシン上で、実行者の権限で動きます。信頼できるコマンドだけを指定してください。

## 6. 再採点(`rescore`)

エージェントを動かさず、保存済みの出力を採点し直します。

```sh
node dist/src/cli.js rescore \
  --predictions run-1/results/predictions.jsonl --predictions run-2/results/predictions.jsonl \
  --splits run-1/splits.json --scorer-cmd "python3 my_grader.py" --reparse \
  --rows-out rescored.jsonl --report summary.json
```

- `--predictions` は複数指定でき、全部の行をまとめて集計します(複数 run の統合)。
- `--scorer exact|contains` か `--scorer-cmd "<コマンド>"` で採点器を選びます。省略時は `exact` です。これ以外の名前はエラーです。
- `--reparse`: 保存済みの `answer` を使わず、**すべての行**で `output` から回答を取り直します(上の抽出規則)。**`answer` が `null` の行は、付けなくても常に取り直されます**(外部 AI の行は `answer` を `null` で書いてかまいません)。
- `--baseline <condition>`: 比較の基準にする条件(既定は `no-skills`)。存在しない名前はエラーです。
- `--splits splits.json`: 各行の課題が、その行の `split` に属しているかを確認し、外れていれば警告します。
- `--strict`: 警告があるときも終了コードを 1 にします。
- `--rows-out`: 再採点後の行を JSONL で保存します。各行の `scorer` が更新され、**元の判定が `correct_original` に残ります**(何度再採点しても最初の値が保たれます)。
- `--report`: 要約を JSON(snake_case)で保存します。

### 警告(結果が無意味になりうる不整合)
`rescore` は、次を見つけると `warning:` を標準エラーに出します。結果の数字を読む前に、必ず確認してください。

- 同じ課題の行どうしで `expected` や `input` が食い違う(条件ごとに別の正解で採点されている)
- 基準の条件にある課題が、ある条件に欠けている(API の失敗などで抜けた課題。**共通の課題だけで比較されます**)
- 基準にない課題が混じっている(比較では無視されます)
- 行の課題が `--splits` の分割に属していない

### 出力の読み方
```
test   evolved   1.000  (4 tasks, 8 rows)  vs no-skills: diff +1.000 on 4 tasks, p=<0.001 (one-sided), <0.001 (two-sided) — significant at 0.05
```
- 行数・課題数・正解率。回答が抽出できなかった行があれば `N without an answer` と出ます(**形式の不一致の可能性が高い**ので、正解率の低さを能力と読み違えないでください)。
- `diff` = この条件 − 基準の平均差。`on N tasks` = 比較に使った課題数。
- p の解像度は 1/1,000 です。**`<0.001` は「0.001 未満」の意味で、ゼロではありません。**
- **片側** p = 「この条件が基準より良い」ことへの検定。基準より悪いと 1.000 近くになりますが、それは「差がない」ことと区別できません。**両側** p も併記されるので、差の有無は両側 p で見てください。
- 課題が 10 件未満だと `[fewer than 10 tasks: low power]` と出ます。1 件でも p は `<0.001` になりえます。

### 統計の定義
- 同じ課題の行が複数ある場合(複数 run や `--repeats`)は、**課題ごとに平均してから** 比較します。比較は両方の条件に行がある課題だけで行います。
- 対応ありブートストラップ: 課題を復元抽出して平均差を計算することを **1,000 回** 繰り返します(乱数は固定シード)。片側 p は平均差が 0 以下になった割合、両側 p は小さい側の割合の 2 倍(上限 1)です。`p < 0.05`(片側)を「有意」と表示します。論文は片側か両側かを書いていないため、この選択は本ツールのものです。
- 採点は並列に実行されます(既定 4)。

## 7. 外部 AI との比較手順

### 7.1 何と何を比べるか
比べる相手によって、結論の意味が違います。

| 比較 | 何を問うか | 注意 |
|---|---|---|
| `evolved` vs `no-skills`(同じモデル・同じハーネス) | **スキルの効果** | WikiSkill の主たる結果 |
| 外部 AI(`evolved` のプロンプト)vs `evolved` | 同じスキルを与えたとき、外部 AI は同じ効果を出すか | モデル間の移植の比較。複数 run のときは [7.4](#74-複数-run-のとき) |
| 外部 AI(`no-skills` のプロンプト)vs `no-skills` | スキルなしの素のモデル同士の比較 | スキルは関係しない |
| 外部 AI(`no-skills` のプロンプト)vs `evolved` | 「WikiSkill 全体」対「外部 AI 単体」 | **条件がそろわない比較**。スキルを使う側が有利で、課題がサンプルのように規則を例から学ぶ型だと、`no-skills` は構造的に 0 % 近くになる。結論に使うなら、条件の違いを必ず明記する |

スキルは **訓練課題の例から学んだ知識** を含みます。訓練とテストが同じ種類の課題であることが前提の効果です。

### 7.2 公平な比較のためのチェックリスト
- [ ] **同じ課題**: `tasks.jsonl` の `split` が `test` の課題だけを使う。`train` / `val` は使わない。
- [ ] **同じプロンプト**: 比較する条件のシステムプロンプトを、`results/prompts/<sha>.txt` の **原文のまま** 使う。ユーザー側のメッセージは、各課題の `input` を **そのまま** 渡す。
- [ ] **同じ回答形式**: 最終返答を `<answer>…</answer>` で終えさせる(上のプロンプトに指示が入っています)。
- [ ] **同じ採点器**: 全条件を **同じ `rescore` 一回** で採点する(条件ごとに採点器を変えない)。
- [ ] **同じ道具立て**: `manifest.json` の `options.agent_tools` が空なら、ツールなしの単発回答です。外部 AI にツールを許す場合は、**ツールの有無が差の原因になる** ことを結果に明記する。
- [ ] **エージェントが見た文脈の違いを把握する**: `claude` CLI は、システムプロンプトのほかに、セッション文脈(現在の日付、アカウントのメールアドレス)をモデルに渡します。外部 AI には渡らず、本ツールでは外せません(保存ログではメールアドレスを `[email]` に置換しています)。起動方法は `manifest.json` の `environment.agent_invocation` にあります。温度などの生成パラメータは本ツールでは設定していません。
- [ ] **モデルの同一性**: `evolved` / `no-skills` が使ったモデルは、各行の `model`(正確なID)で確認する。`manifest.environment.models` は指定した別名です。
- [ ] **反復**: 外部 AI にも温度・乱数があるなら、複数回走らせて平均する(同じ回数を各条件にそろえる)。
- [ ] **テストを見てから調整しない**: 外部 AI のプロンプトや設定を、テストの結果を見て直さない。直した場合は、全試行を報告する。

### 7.3 手順
1. `results/prompts/` から比較したい条件のシステムプロンプトを取り出す。
2. `tasks.jsonl` の `split` が `test` の各課題について、外部 AI を呼び出す(システムプロンプト = 手順1、ユーザーメッセージ = `input`)。
3. 回答を **同じ形式の行** にして `external.jsonl` に書く(下の例)。
   - `condition`: `external:<名前>`(名前は一意に)
   - `run`: `ext-1` など
   - `split`: `test`
   - `input` / `expected` / `task_id`: **必ず `tasks.jsonl` からそのまま写す**(手で作り直さない)
   - `answer`: `null` でよい(再採点で `output` から取り直されます)
   - `iteration`: `0`。`scorer`: 何でもよい。`correct`: 何でもよい(再採点で上書きされます)
   - `system_prompt_sha256`: 外部 AI に渡したプロンプトの SHA-256。**独自のプロンプトを使った場合は、その原文を保存し、そのハッシュを入れる**
4. 比較する。
   ```sh
   node dist/src/cli.js rescore \
     --predictions run-1/results/predictions.jsonl --predictions external.jsonl \
     --splits run-1/splits.json --scorer-cmd "python3 my_grader.py" --baseline evolved
   ```
   `external:<名前>` が `evolved`(進化後のスキル)に対してどうかが、`vs evolved: …` として表示されます。`--baseline no-skills`(既定)なら、スキルなしに対する比較になります。**警告が出ていないか、`N without an answer` が多くないかを必ず確認してください。**

### 7.3.1 外部 AI の行を作る例(Python)

```python
import hashlib, json

# プロンプトは「バイト列」で読み、ハッシュはそのバイト列で計算する(改行コードの変換でずれるのを避ける)
raw = open("run-1/results/prompts/<evolved の sha>.txt", "rb").read()
SYSTEM = raw.decode("utf-8")
sha = hashlib.sha256(raw).hexdigest()

def call_external_ai(system: str, user: str) -> str:
    raise NotImplementedError  # 外部 AI を呼び出し、返答全文を返す

with open("external.jsonl", "w", encoding="utf-8") as f:
    for line in open("run-1/tasks.jsonl", encoding="utf-8"):
        t = json.loads(line)
        if t["split"] != "test":
            continue
        output = call_external_ai(SYSTEM, t["input"])
        row = {
            "schema_version": 1, "run": "ext-1", "split": "test",
            "condition": "external:my-ai", "iteration": 0,
            "task_id": t["id"], "input": t["input"], "expected": t["expected"],
            "answer": None,                          # rescore が output から取り直す
            "correct": False, "scorer": "exact",     # 再採点で上書きされる
            "system_prompt_sha256": sha, "output": output,
        }
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
```

### 7.4 複数 run のとき
`--runs N` の成果物では、**run ごとに `evolved` のスキルとプロンプトが違います**(`no-skills` のプロンプトは全 run で同一)。`rescore` に複数の `predictions.jsonl` を渡すと、全 run の `evolved` が1つの条件にまとまり、課題ごとに平均されます(論文も3回の進化の平均で報告しています)。

外部 AI に `evolved` のプロンプトを使わせる比較では、次のどちらかにしてください。
- **推奨**: run ごとに、その run の `evolved` のプロンプトを外部 AI に渡し、`run` を `ext-1`, `ext-2`, … とする。`condition` は全部同じ `external:<名前>` にする。これで、課題ごとに平均した `evolved` と対応がとれます。
- 簡便: 1つの run の `evolved` だけを使う。その場合は、`rescore` にも、その run の `predictions.jsonl` だけを渡す。

### 7.5 スキル自体を別のモデルで試す(モデル間の移植)
外部 AI ではなく「別のモデルでもこのスキルは効くか」を見る場合は、`eval` を使います(`claude` CLI または OpenAI 互換のエンドポイントが必要で、LLM を呼びます)。

```sh
node dist/src/cli.js eval --tasks run-1/tasks.jsonl --split test --infer-model <モデル> \
  --skills evolved=run-1/skills --predictions-out transfer/predictions.jsonl
```

出力は同じ形式の `predictions.jsonl`(`condition` は `no-skills` とスキルセット名)なので、`rescore` でそのまま採点・比較できます。プロンプトの原文は、指定したファイルと同じ場所の `prompts/<sha256>.txt` に保存されます。`--predictions-out` を付けない場合は、集計だけが表示され、行は保存されません。

## 8. 保証と非保証

### `check` が機械的に確認すること
[2](#2-受け取ったらまずやること) の一覧のとおり。要点は次のとおりです。
- run が完了していること。`predictions.jsonl`・`tasks.jsonl`・`splits.json` が **完了後に書き換えられていない** こと(ハッシュ)。`skills/` が記録と一致すること。
- 分割に矛盾がなく、テスト課題がゲートの検証にも訓練トレースにも現れないこと。テスト行の書き込み時刻が、ゲート行より後であること。
- テストの全課題について、`no-skills` と `evolved` が1行ずつあること。

### 送り元の申告(`check` では確かめられません)
- `output` は、エージェントの実際の出力の記録で、採点の都合で加工していない(メールアドレス形式の伏せ字を除く)。
- テスト課題を進化の途中で一度もエージェントに渡していない。`check` が見られるのは痕跡(行・トレース・時刻)だけで、実行中の挙動そのものではありません。
- ハッシュは **完了後の取り違えや偶発的な編集** を見つけるためのもので、悪意のある改ざんを防ぐ署名ではありません(ハッシュ自体も `manifest.json` の中にあるため)。厳密に固定したい場合は、受け取った時点で、成果物全体のハッシュを別の経路で控えてください。
- `predictions.jsonl` は、`schema_version: 1` の間、必須フィールドの追加・削除・意味の変更をしない。

### 保証しないこと
- **結果の再現性**: LLM の出力は呼び出しごとに変わります。同じ設定で再実行しても、同じ数値にはなりません。温度などの生成パラメータは、`claude` CLI 経由のため固定していません。
- **論文の数値との一致**: 本実装は論文の非公式な再実装で、論文の結果との一致は検証していません。
- **一般性**: 同梱のサンプル課題は合成データで、結果は「仕組みが動くこと」の確認に留まります。

## 9. 既知の制約と注意

- **サンプル課題は合成です**。`examples/` の課題(会員ID生成)は、規則を例から推測させる単純なもので、実際の評価用ではありません。本番の評価では、課題セットと分割の定義が別途必要です。
- **テストが小さいと不安定です**。数十件未満では、p 値も正解率も大きく揺れます。複数 run の平均と信頼区間を併せて見てください。
- **ゲートの選択バイアス**: スキルは検証セットで選ばれているため、検証の正解率は楽観的です。比較にはテストを使ってください。
- **エージェントのツールは本物のサンドボックスではありません**。`options.agent_tools` が空でない run は、許可パターンの範囲でコマンドが実行されています。
- **実行ログに含まれる情報**: `output` にはモデルの推論過程が含まれます。メールアドレス形式だけを `[email]` に伏せていますが、ほかは伏せていません。**再配布の可否は、送り元の責任者が判断します**(外部に出す前に確認してください)。
- **暫定採点の限界**: 組み込みの採点は文字列比較だけです。表計算の結果比較など、課題に固有の採点が必要なら、[外部の採点コマンド](#外部の採点コマンドcustom)を使ってください(ただし作業ファイルに依存する採点は `rescore` で再実行できません)。
- **続きから実行した run**: `manifest.options.resume` が `true` の run は、前回のスキルから続けています(複数 run `--runs N` と `--resume` は併用できません。run は1つずつ再開します)。`predictions.jsonl` のテスト行と `no-skills` の検証行は、続行時に作り直されるため重複しません(`check` で確認できます)。

## 10. バージョンと変更ルール

- すべての引き渡しファイルに `schema_version` があります。現在は **`1`** です。
- **互換を保つ変更**(バージョンは上げない): フィールドの**追加**(`model`、`created_at`、`files_sha256` のような任意項目)、`condition` の新しい値の追加、ドキュメントの追記。受け取る側は、未知のフィールドを無視してください。
- **互換を壊す変更**(バージョンを上げる): 必須フィールドの削除・名前変更・型や意味の変更。`rescore` と `check` は、自分より新しい `schema_version` を拒否します。
- 作成中のため、`schema_version: 1` が確定するまで(引き渡しの合意をもって確定とします)は、送り元から連絡なく変わることはありません。変わる場合は、本書の冒頭に変更点を記載します。
- 受け取った成果物の再現・追跡のため、`manifest.json` の `environment.tool.git_commit` のコードを使ってください([2](#2-受け取ったらまずやること))。

## 11. よくある質問

| 質問 | 答え |
|---|---|
| 元の課題ファイルはどこですか。 | 各 run の `tasks.jsonl`(分割つき)。課題ごとの添付ファイルは含まれません。本番の課題セットと分割は、別途送り元から受け取ります。 |
| 正式な採点基準は誰が決めますか。 | 受け取るチームが決めてかまいません。送り元に別の正式基準はなく、`correct` は暫定です。 |
| `no-skills` と `evolved` の差は何の効果ですか。 | スキル(訓練課題の例から学んだ知識)の効果です。外部 AI との比較でどれを使うかは [7.1](#71-何と何を比べるか)。 |
| エージェントは何を見ましたか。 | `results/prompts/` のシステムプロンプトと、課題の `input`(ユーザーメッセージ)、およびセッション文脈(日付など)。詳細は [7.2](#72-公平な比較のためのチェックリスト) と `environment.agent_invocation`。 |
| 「同じモデル」とは何ですか。 | 各行の `model` の ID。`manifest` の `task_agent` は指定した別名です。 |
| `git_dirty: true` のとき、コードの差分はどこですか。 | `results/code.diff`([2](#2-受け取ったらまずやること))。 |
| 回答が抽出できなかった行は何件ですか。 | `rescore` の出力の `N without an answer`。 |
| 外部 AI の行を検証するツールはありますか。 | `rescore` の警告と `--splits`([6](#6-再採点rescore))。 |
| `output` を外部に出してよいですか。 | 送り元の責任者に確認してください([1](#1-責任の分担)、[9](#9-既知の制約と注意))。 |

## 付録: 用語

| 用語 | 意味 |
|---|---|
| スキル | エージェントのシステムプロンプトに入れる手順書(`SKILL.md`)。進化によって作られる |
| wiki | 進化の途中の知識ベース。**課題を解くエージェントには見せない**(`wiki_hidden_from_task_agent`) |
| ゲート | 検証セットで過去最高を厳密に上回った編集だけを採用する判定 |
| 条件(condition) | 回答を出したもの(スキルなし/進化後/外部 AI など) |
| 基準(baseline) | 比較の相手にする条件。既定は `no-skills` |
| 検証(val) / テスト(test) | 検証はゲート判定に使い、テストは最後の1回だけ使う |

元の方法の説明は [README](../README.md) と、論文 [arXiv:2608.27454](https://arxiv.org/abs/2608.27454) を参照してください。
