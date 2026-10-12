# 引き渡しガイド: WikiSkill 実験結果の最終スコア付けと外部 AI との比較

> **🚧 作成中のプロジェクトです。** 本書の内容は `schema_version: 1` の時点のものです。ファイル形式の変更ルールは
> [10. バージョンと変更ルール](#10-バージョンと変更ルール) にあります。免責は [README](../README.md#copyright-and-disclaimer) のとおりです。

**対象読者**: 最終的なスコア付けと、外部 AI との比較を担当するチーム。WikiSkill 自体の知識は前提にしません。

---

## 0. 先に読む要点

1. 渡すのは **1回の実験(run)の成果物一式** です。点数だけでなく、**全回答・全出力・エージェントが見たプロンプトの原文** を含みます。したがって、**採点方法を変えても、エージェントを再実行せずに再採点できます**(`wikiskill rescore`)。
2. 比較の中心は `results/predictions.jsonl` です。1行 = 「ある課題を、ある条件(スキルなし/進化後など)で解いた1回の結果」です。
3. 保持済みテスト分割(`test`)は、進化の途中では一度も使っていません。`wikiskill check` で機械的に確認できます。
4. 外部 AI と比べる場合は、**同じ課題・同じプロンプト・同じ回答形式・同じ採点器** にそろえてください([7. 外部 AI との比較手順](#7-外部-ai-との比較手順))。
5. 受け取ったら最初に **`wikiskill check --run <dir>`** を実行してください。壊れた成果物や、未完了の run を受け取る事故を防げます。

## 1. 責任の分担

| | WikiSkill 側(渡す側) | 受け取るチーム |
|---|---|---|
| 課題の分割(train / val / test) | `splits.json` に固定して渡す | 変更しない |
| スキルの進化 | 実行済み。最終スキルは `skills/` に固定 | **やり直さない**(テスト結果を見てからの再進化は、テストを訓練に使うのと同じです) |
| 最終スコア付け | 暫定の採点結果を `correct` に保存 | **正式な採点はこちら**(`rescore`) |
| 外部 AI との比較 | `eval` / `rescore` の仕組みと本書を提供 | 実施・結論づけ |
| 結果の解釈 | 保証と制約を [8](#8-保証と非保証)・[9](#9-既知の制約と注意) に記載 | 本書の制約を踏まえて解釈 |

## 2. 受け取ったらまずやること

```sh
git clone https://github.com/HalkPapa/WikiSkill && cd WikiSkill
npm install && npm run build
node dist/src/cli.js check --run <成果物のディレクトリ>
```

`OK` と表示され、`problem:` が出なければ、次を満たしています。

- run が `completed` で終わっている(途中停止や失敗ではない)
- `manifest.json`・`splits.json`・`results/predictions.jsonl` が互いに矛盾しない
- どの課題も、train / val / test のどれか1つだけに属する
- テスト課題が、進化の途中(ゲートの検証や訓練トレース)に使われていない
- テストの `no-skills` と `evolved` が、全課題について**ちょうど1行ずつ**ある
- 参照されるプロンプト全件が `results/prompts/` にあり、ハッシュが名前と一致する
- `skills/` の内容が、`manifest.json` に記録されたハッシュと一致する(run 後に書き換えられていない)

複数回実行(`--runs N`)の場合は、親ディレクトリを渡すと `run-1`, `run-2`, … を順に検査します。`FAIL` の run は使わず、送り元に連絡してください。

## 3. 成果物の構成

```
<run のディレクトリ>/
├── manifest.json            何が・どの環境で・どの設定で作ったか(5. 参照)
├── splits.json              課題ID → train / val / test の割り当て
├── report.json              暫定の集計(検証・テストの正解率、ブートストラップ結果)
├── results/
│   ├── predictions.jsonl    ★ 比較の中心。1行 = 1回の試行(4. 参照)
│   └── prompts/<sha256>.txt エージェントが見たシステムプロンプトの原文(ハッシュで参照)
├── skills/<名前>/           ★ 最終スキル(SKILL.md / PURPOSE.md / 同梱ファイル)
├── raw/iter-NN/<課題>.json  訓練課題の実行トレース(テスト課題は含まれない)
└── wiki/                    進化の途中の知識(patterns/・index.md・logs.md・skill-impact.md)
```

`--runs N`(N>1)の場合は、親ディレクトリの下に `run-1/`, `run-2/`, … が並び、それぞれが上の構成を持ちます。親の `report.json` には平均が入ります。

比較に必要なのは `results/` と `skills/`、`splits.json`、`manifest.json` です。`raw/` と `wiki/` は、進化の過程を調べるときの資料です。

## 4. `results/predictions.jsonl` の仕様

1行が1つの JSON オブジェクトです(JSON Schema: [`schema/prediction-row.schema.json`](schema/prediction-row.schema.json))。

| フィールド | 型 | 意味 |
|---|---|---|
| `schema_version` | 整数 | 形式のバージョン(現在 `1`) |
| `run` | 文字列 | `run-1`, `run-2`, … 。`eval` では指定した名前 |
| `split` | 文字列 | `val` または `test`(`eval` では指定した分割) |
| `condition` | 文字列 | 何が答えたか(下表) |
| `iteration` | 整数 | `candidate:` の行ではゲートの反復番号。それ以外は `0` |
| `task_id` | 文字列 | 課題ID(`splits.json` と対応) |
| `input` | 文字列 | エージェントに渡した課題文 |
| `expected` | 文字列 | 正解 |
| `answer` | 文字列 / null | 出力から抽出した回答。見つからなければ `null`(不正解扱い) |
| `correct` | 真偽 | 暫定の採点結果(再採点で上書き可能。元の値は `correct_original` に残る) |
| `scorer` | 文字列 | 暫定の採点器: `exact` / `contains` / `custom` |
| `system_prompt_sha256` | 文字列 | エージェントが見たシステムプロンプトの SHA-256。原文は `results/prompts/<値>.txt` |
| `output` | 文字列 | 実行ログ全文(推論過程・ツール呼び出し・ツール出力・最終返答) |

### `condition` の値

| 値 | 意味 | 比較に使うか |
|---|---|---|
| `no-skills` | スキルなし。**同じモデル・同じハーネス**でスキルだけ外したもの | ✅ 基準(ベースライン) |
| `evolved` | 最終スキル(`skills/`)を使ったもの | ✅ 評価対象 |
| `candidate:<スキル名>@iter<k>` | 進化中のゲート判定のための検証(`val`)の試行 | ❌ 簿記用(要約から除外される) |
| `resumed-skills` | 続きから実行したとき、開始時点のスキルの検証 | ❌ 簿記用 |
| 任意の名前 | `eval` で評価したスキルセットの名前、または外部 AI の行(`external:<名前>` を推奨) | ✅ |

### 例(1行。見やすく整形)

```json
{"schema_version":1,"run":"run-1","split":"test","condition":"evolved","iteration":0,
 "task_id":"x1","input":"Generate the internal member ID for: Liam Murphy, born 1988.",
 "expected":"MUR88L","answer":"MUR88L","correct":true,"scorer":"exact",
 "system_prompt_sha256":"3f1c…","output":"[thinking] …\n[final] <answer>MUR88L</answer>"}
```

サンプルファイル: [`examples/predictions.sample.jsonl`](examples/predictions.sample.jsonl)(合成データ。形式の確認用です)。

### その他のファイル

- **`splits.json`**: `{"schema_version":1,"train":[…],"val":[…],"test":[…]}`。課題IDの一覧です。
- **`manifest.json`**([`schema/manifest.schema.json`](schema/manifest.schema.json)): 次を含みます。
  - `status`(`completed` 以外の run は使わない)、開始・終了時刻、失敗時の `error`
  - `environment`: 使ったコードのバージョンと git コミット(`git_dirty` が `true` なら未コミット変更あり)、Node と `claude` CLI のバージョン、モデル名、課題ファイルのパスと SHA-256、外部採点コマンド
  - `options`: 反復回数、採点器、分割比率、並列数、エージェントのツール、wiki の可視性など
  - `skills`: 最終スキル名と、スキルごと/全体の SHA-256
  - `guarantees`: 次の [8](#8-保証と非保証) の保証
- **`report.json`**: 暫定の集計。**正式な数値は `predictions.jsonl` から再計算してください。**

## 5. 採点の仕様(暫定の採点が何をしているか)

### 回答の抽出
次の順に探し、最初に見つかったものを回答とします(前後の空白は除きます)。

1. 最終返答にある **最後の** `<answer>…</answer>`(大文字小文字は区別しない)
2. 最終返答にある最後の `ANSWER: …` 行
3. 実行ログ全体にある最後の `<answer>…</answer>`
4. 実行ログ全体にある最後の `ANSWER: …` 行

どれもなければ `answer` は `null` で、**不正解** です。

### 組み込みの採点器
どちらも、比較前に回答と正解を次のとおり正規化します: 前後の空白を除く → 小文字にする → 連続する空白を1つにする → 末尾の `.` または `。` を1つ除く。

- `exact`: 正規化後に **完全一致**
- `contains`: 正規化後の回答に、正規化後の正解が **含まれる**

### 外部の採点コマンド(`custom`)
独自の採点器を使う場合のインターフェースです。コマンドは `sh -c` で、**1回答につき1回** 実行されます。

- **標準入力**: 1つの JSON `{"id","input","expected","answer","output"}`(`answer` は `null` のことがあり、`output` は実行ログ全文)
- **標準出力**: `true` / `false` / `1` / `0`、または `{"correct": true}` / `{"score": 1}`(`score` は 1 以上で正解)
- 終了コードが 0 以外、または 60 秒を超えた場合は **不正解** として扱い、標準エラーに警告を出します。
- コマンドは、実行するマシン上で、実行者の権限で動きます。信頼できるコマンドだけを指定してください。

## 6. 再採点(`rescore`)

エージェントを動かさず、保存済みの出力を採点し直します。

```sh
node dist/src/cli.js rescore \
  --predictions run-1/results/predictions.jsonl --predictions run-2/results/predictions.jsonl \
  --scorer-cmd "python3 my_grader.py" --reparse \
  --rows-out rescored.jsonl --report summary.json
```

- `--predictions` は複数指定でき、全部の行をまとめて集計します(複数 run の統合)。
- `--scorer exact|contains` か `--scorer-cmd "<コマンド>"` で採点器を選びます。省略時は `exact` です。
- `--reparse`: 保存済みの `answer` を使わず、各行の `output` から回答を取り直します(回答の抽出ルールも変えたい場合)。
- `--baseline <condition>`: 比較の基準にする条件(既定は `no-skills`)。
- `--rows-out`: 再採点後の行を JSONL で保存します。各行の `scorer` が更新され、**元の判定が `correct_original` に残ります**(何度再採点しても最初の値が保たれます)。
- 出力の要約は、`split` と `condition` ごとに、行数・課題数・正解率と、基準に対する **対応ありブートストラップ** の p 値を表示します。

### 統計の定義
- 同じ課題の行が複数ある場合(複数 run や `--repeats`)は、**課題ごとに平均してから** 比較します。比較は両方の条件に行がある課題だけで行います。
- 対応ありブートストラップ: 課題を復元抽出して平均差を計算することを **1,000 回** 繰り返し(乱数は固定シード)、平均差が 0 以下になった割合を p 値とします(**片側**。論文は片側か両側かを書いていないため、これは本ツールの選択です)。`p < 0.05` を「有意」と表示します。
- 課題数が少ないと検定力は低くなります。有意でないことは「差がない」ことを意味しません。

## 7. 外部 AI との比較手順

### 7.1 公平な比較のためのチェックリスト
- [ ] **同じ課題**: `splits.json` の `test` の課題だけを使う。`train` / `val` は使わない。
- [ ] **同じプロンプト**: 比較する条件のシステムプロンプトを、`results/prompts/<sha>.txt` の **原文のまま** 使う(`no-skills` と `evolved` で別のファイル)。ユーザー側のメッセージは、各行の `input` を **そのまま** 渡す。
- [ ] **同じ回答形式**: 最終返答を `<answer>…</answer>` で終えさせる(上のプロンプトに指示が入っています)。
- [ ] **同じ採点器**: 全条件を **同じ `rescore` 一回** で採点する(条件ごとに採点器を変えない)。
- [ ] **同じ道具立て**: `manifest.json` の `options.agent_tools` が空なら、ツールなしの単発回答です。外部 AI にツール(検索・コード実行など)を許す場合は、**ツールの有無が差の原因になる** ことを結果に明記する。
- [ ] **反復**: 外部 AI にも温度・乱数があるなら、複数回走らせて平均する(同じ回数を各条件にそろえる)。
- [ ] **テストを見てから調整しない**: 外部 AI のプロンプトや設定を、テストの結果を見て直さない。直した場合は、全試行を報告する。

### 7.2 手順
1. `results/prompts/` から比較したい条件のシステムプロンプトを取り出す。
2. `test` の各課題について、外部 AI を呼び出す(システムプロンプト = 手順1、ユーザーメッセージ = `input`)。
3. 回答を **同じ形式の行** にして `external.jsonl` に書く(下の例)。
   - `condition`: `external:<名前>`(名前は一意に)
   - `run`: `ext-1` など(複数回なら `ext-2`, …)
   - `split`: `test`
   - `iteration`: `0`
   - `scorer`: 何でもよい(再採点で上書きされます)
   - `system_prompt_sha256`: 外部 AI に渡したプロンプトの SHA-256。**独自のプロンプトを使った場合は、その原文を保存し、そのハッシュを入れる**
4. 比較する。
   ```sh
   node dist/src/cli.js rescore \
     --predictions run-1/results/predictions.jsonl --predictions external.jsonl \
     --scorer-cmd "python3 my_grader.py" --baseline evolved
   ```
   `external:<名前>` が `evolved`(進化後のスキル)に対してどうかが、`vs evolved: p=…` として表示されます。`--baseline no-skills`(既定)なら、スキルなしに対する比較になります。

### 7.3 外部 AI の行を作る例(Python)

```python
import hashlib, json

SYSTEM = open("run-1/results/prompts/<evolved の sha>.txt", encoding="utf-8").read()
sha = hashlib.sha256(SYSTEM.encode("utf-8")).hexdigest()
tasks = [json.loads(l) for l in open("tasks.jsonl", encoding="utf-8")]
test_ids = set(json.load(open("run-1/splits.json"))["test"])

def call_external_ai(system: str, user: str) -> str:
    raise NotImplementedError  # 外部 AI を呼び出し、返答全文を返す

with open("external.jsonl", "w", encoding="utf-8") as f:
    for t in tasks:
        if str(t["id"]) not in test_ids:
            continue
        output = call_external_ai(SYSTEM, t["input"])
        row = {
            "schema_version": 1, "run": "ext-1", "split": "test",
            "condition": "external:my-ai", "iteration": 0,
            "task_id": str(t["id"]), "input": t["input"], "expected": str(t["expected"]),
            "answer": None,            # --reparse で output から取り直すなら None でよい
            "correct": False, "scorer": "exact",   # 再採点で上書きされる
            "system_prompt_sha256": sha, "output": output,
        }
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
```

`answer` を `None` にした行は、`rescore` に `--reparse` を付けると `output` から回答が取り出されます。

### 7.4 スキル自体を別のモデルで試す(モデル間の移植)
外部 AI ではなく「別のモデルでもこのスキルは効くか」を見る場合は、`eval` を使います(`claude` CLI または OpenAI 互換のエンドポイントが必要です)。

```sh
node dist/src/cli.js eval --tasks tasks.jsonl --split test --infer-model <モデル> \
  --skills evolved=run-1/skills --predictions-out transfer/predictions.jsonl
```

出力は同じ形式の `predictions.jsonl`(`condition` は `no-skills` とスキルセット名)なので、`rescore` でそのまま採点・比較できます。プロンプトの原文は、指定したファイルと同じ場所の `prompts/<sha256>.txt`(上の例では `transfer/prompts/`)に保存されます。`--predictions-out` を付けない場合は、集計だけが表示され、行は保存されません。

## 8. 保証と非保証

### 保証すること(`check` と自動テストで確認)
- テスト課題は、**進化の途中で一度もエージェントに渡していない**(ゲートの検証にも訓練にも使っていない)。テストの試行は、進化の完了後に行っている(続きから実行した場合は、最終スキルでやり直し、古い行を置き換える)。
- `skills/` は、`manifest.json` のハッシュと一致する間は、run が作った最終スキルそのものである。
- 各行の `output` は、エージェントの実際の出力の記録で、採点の都合で加工していない(伏せ字を除く。[9](#9-既知の制約と注意))。
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
- **実行ログに含まれる情報**: `output` にはモデルの推論過程が含まれます。Claude Code が各セッションに付ける文脈のうち、**メールアドレス形式だけ** を `[email]` に伏せていますが、ほかは伏せていません。外部に再配布する前に中身を確認してください。
- **暫定採点の限界**: 組み込みの採点は文字列比較だけです。表計算の結果比較など、課題に固有の採点が必要なら、[外部の採点コマンド](#外部の採点コマンドcustom)を使ってください。
- **続きから実行した run**: `manifest.options.resume` が `true` の run は、前回のスキルから続けています。`predictions.jsonl` のテスト行と `no-skills` の検証行は、続行時に作り直されるため重複しません(`check` で確認できます)。

## 10. バージョンと変更ルール

- すべての引き渡しファイルに `schema_version` があります。現在は **`1`** です。
- **互換を保つ変更**(バージョンは上げない): フィールドの**追加**、`condition` の新しい値の追加、ドキュメントの追記。受け取る側は、未知のフィールドを無視してください。
- **互換を壊す変更**(バージョンを上げる): 必須フィールドの削除・名前変更・型や意味の変更。`rescore` と `check` は、自分より新しい `schema_version` を拒否します。
- 作成中のため、`schema_version: 1` が確定するまで(引き渡しの合意をもって確定とします)は、送り元から連絡なく変わることはありません。変わる場合は、本書の冒頭に変更点を記載します。
- 受け取った成果物の再現・追跡のため、`manifest.json` の `environment.tool.git_commit` のコードを使ってください。

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
