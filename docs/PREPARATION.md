# 準備ガイド: 再現フェーズに入る前に必要なものと手順

> **🚧 作成中。** 再現の方針と理由は [`REPRODUCTION.md`](REPRODUCTION.md)、結果の受け渡しは [`HANDOFF.md`](HANDOFF.md) にあります。
> 本書は「何を用意し、どう進めるか」だけをまとめます。
> **検証の状態**を各 HOWTO に書きました。✅ = 実際に実行して確かめた、⚠️ = 手順は書けるが未検証。

**対象読者**: プロジェクトの責任者(あなた)。コンパス(AI のプロジェクトリーダー)が補助します。

---

## 1. 準備チェックリスト

| # | 項目 | 担当 | 状態 | 手順 |
|---|---|---|---|---|
| 1 | 実行環境(Node 22 以上、`claude` CLI のログイン、ビルド) | あなた | ✅ この Mac では確認済み | [HOWTO 1](#howto-1-実行環境を確認する) |
| 2 | 利用枠・費用の確認と、使う上限の決定 | **あなた** | ⬜ 未 | [HOWTO 2](#howto-2-利用枠と費用を確認し上限を決める) |
| 3 | LiveMath のデータと**論文と同じ分割**の入手 | **あなた**(探す)+ コンパス(変換) | ⬜ **未(最大の待ち事項)** | [HOWTO 3](#howto-3-データセットを入手して-tasksjsonl-にする) |
| 4 | 使うモデルの決定 | **あなた** | ⬜ 未(既定案あり) | [決めてほしいこと](#7-決めてほしいこと) |
| 5 | パイロット実行(最大約128呼び出し) | コンパス(あなたの許可後) | ⬜ 未 | [HOWTO 4](#howto-4-パイロットを実行する) |
| 6 | パイロットの実測から本番の費用を見積もる | コンパス → あなたが承認 | ⬜ 未 | [HOWTO 5](#howto-5-実測から本番の費用を見積もる) |
| 7 | 本番(3回独立実行、K=8) | コンパス | ⬜ 未 | [HOWTO 6](#howto-6-本番を実行する3回を1回ずつ) |
| 8 | アブレーション(wiki なし) | コンパス | ⬜ 未 | [HOWTO 7](#howto-7-アブレーションを実行する) |
| 9 | 受け取るチームへの引き渡し | コンパス + あなた | ⬜ 未 | [HOWTO 8](#howto-8-受け取るチームへ引き渡す) |
| 10 | (任意)ローカルモデルで推論を回す | あなた | ⚠️ 未検証 | [HOWTO 9](#howto-9-任意ローカルモデルで推論を回す) |
| 11 | (後続)OfficeQA / SpreadsheetBench / SealQA の追加準備 | あなた + コンパス | ⬜ 後続 | [HOWTO 10](#howto-10-後続ほかのベンチマークの追加準備) |

コンパス側で**準備済み**のもの: 進化ループ、引き渡し形式と検査(`check` / `rescore`)、論文の推論プロンプト5種、課題ファイルの変換(`make-tasks`)、費用の計測と上限(`--max-cost`)、1回ずつ実行する仕組み(`--run-label`)、テスト71本、見本の run。

---

## HOWTO 1: 実行環境を確認する
✅ この Mac で確認済み(Node v22.22.2、`claude` 2.1.207)。

1. Node のバージョン(22 以上):
   ```sh
   node -v
   ```
2. `claude` CLI がログイン済みで動くこと(1回だけ、ごく小さな呼び出しです):
   ```sh
   claude --version
   echo "Reply with <answer>ok</answer>." | claude -p --model haiku
   ```
   `<answer>ok</answer>` が返れば OK です。ログインを求められたら、対話の `claude` を起動して案内に従ってください。
3. リポジトリを最新にして、ビルドとテスト(テストはネットワーク不要で、利用枠を消費しません):
   ```sh
   cd ~/MyWorks/WikiSkill
   git pull
   npm install && npm run build
   npm test
   ```
   `# fail 0` になれば準備完了です。
4. 見本の run が通ることを確認(LLM を呼びません):
   ```sh
   node dist/src/cli.js check --run examples/reference-run
   ```

## HOWTO 2: 利用枠と費用を確認し、上限を決める
⚠️ 利用枠の表示は Claude Code のバージョンで異なるため、画面の案内に従ってください。

1. **プランの種類を確認**する(サブスクリプション Pro / Max か、API キーの従量課金か)。
2. サブスクリプションの場合、Claude Code の対話画面で `/usage` を実行して、**5時間の枠**と**週の上限**の残りを見ます。
3. 見積もりの目安(詳細は [`REPRODUCTION.md`](REPRODUCTION.md) §4):
   - 1回の呼び出しは、最小でも `haiku` で約 $0.014、`sonnet` で約 $0.036(定価ベース。サブスクリプションでは請求額ではなく枠で消費)。
   - LiveMath のパイロットは最大約128呼び出し、論文の条件の全実行は最大約2,100呼び出し。
   - **Pro では、全実行は現実的でないと見ています**(パイロットは数枠に分ければ可能な見込み)。
4. **上限を決める**: パイロットは `--max-cost 8` のように、実行ごとに USD で指定します。上限に達すると、次の呼び出しの前に止まり、`--resume` で続きから再開できます。実行中の呼び出しは終わるので、少し超えることがあります(`--concurrency 1` なら最大1呼び出し分)。
5. 決めた上限を、コンパスに伝えてください(「パイロットは $X まで」)。

## HOWTO 3: データセットを入手して tasks.jsonl にする
⚠️ 変換コマンドは動作確認済み(✅、合成データ)。**実際のデータの形式は未確認**のため、手順 3 はデータを見て調整します。

### 3-1. 何を入手するか
LiveMathematicianBench のデータと、**論文と同じ分割**(訓練 35 / 検証 18 / テスト 124)です。論文は、分割とツールを先行研究と**厳密に一致させた**と書いています。分割を自分で作ると、再現とは呼べません。

出典(論文の参考文献より。**配布場所の URL は論文に書かれていません**):

| 何 | 出典 |
|---|---|
| LiveMathematicianBench のデータ | He et al. 2026, [arXiv:2604.01754](https://arxiv.org/abs/2604.01754) |
| 分割の元になった先行研究 | SkillOpt: Yang et al. 2026, [arXiv:2605.23904](https://arxiv.org/abs/2605.23904) / EvoSkill: Alzubi et al. 2026, [arXiv:2603.02766](https://arxiv.org/abs/2603.02766) |

進め方の案: 上の論文の本文・付録・リポジトリへのリンクをたどり、(a) データの入手先、(b) 35/18/124 の分割(課題ID の一覧、または分割済みファイル)を探します。**見つからない場合は、論文の著者に問い合わせるのが確実**です(論文の連絡先は [arXiv の概要ページ](https://arxiv.org/abs/2608.27454))。

### 3-2. 必要なデータの形
各課題が、次を持っていれば変換できます。

- ID(一意)
- 問題文と選択肢
- 正解(選択肢のラベル。例 `A`)
- 分割の情報(データ内の列、または課題IDの一覧ファイル)

### 3-3. tasks.jsonl への変換
データ(JSONL または JSON 配列)を、`make-tasks` で変換します。例(欄の名前 `qid`、`q.text`、`q.choices`、`answer`、`part` は**例**です。実際のデータに合わせて変えてください):

```sh
# 分割がデータの列(train / val / test)に入っている場合
node dist/src/cli.js make-tasks --in livemath.json --id-field qid \
  --input-template "{q.text}

Choices:
{q.choices}" \
  --expected answer --split-field part --tasks-out livemath/tasks.jsonl

# 分割が課題IDの一覧(splits.json = {"train":[…],"val":[…],"test":[…]})で渡される場合
node dist/src/cli.js make-tasks --in livemath.json --id-field qid \
  --input-template "{q.text}

Choices:
{q.choices}" \
  --expected answer --splits splits.json --tasks-out livemath/tasks.jsonl
```

- `{q.text}` のようにドットで入れ子の欄を指せます。配列(選択肢)は1項目1行になります。存在しない欄を指すと、黙って空にせずエラーになります。
- 出力例: `wrote 177 tasks to livemath/tasks.jsonl: train 35, val 18, test 124`。**この件数が論文の表6と一致することを必ず確認**してください。
- `--random-split 35/18/124 --seed 1` は**論文の分割ではありません**(警告が出ます)。仕組みの動作確認にだけ使い、再現の結果としては報告しないでください。

### 3-4. 確認すること
1. 件数が 35 / 18 / 124 であること。
2. `tasks.jsonl` を数行見て、`input` が問題と選択肢を含み、`expected` がラベルだけであること。
3. 正解の書式(`A` か `(A)` か)が、論文のプロンプトの指示(`<answer>` の中に選択肢のラベルだけ)と合っていること。合わなければ `--expected` のテンプレートで整えます。

## HOWTO 4: パイロットを実行する
⚠️ LiveMath のデータ入手後。コマンドの形式は動作確認済み(✅、見本の run)。**あなたの許可と上限が決まってから実行します。**

パイロット = 1回・2反復・**テストなし**(最大約128呼び出し。ゲートの検証は、提案が出たときだけ走るので、これ以下になることもあります)。テスト分割を使わないよう、検証までの分割だけの課題ファイルで走らせます。

1. テストなしの課題ファイルを作る(`split` が `test` の行を除く):
   ```sh
   grep -v '"split":"test"' livemath/tasks.jsonl > livemath/tasks-pilot.jsonl
   wc -l livemath/tasks-pilot.jsonl     # 53 になること(35 + 18)
   ```
2. 作業ツリーが**きれい**であることを確認(未コミットの変更があると、成果物に `git_dirty: true` が記録されます):
   ```sh
   git status --porcelain      # 何も出ないこと
   ```
3. 実行(推論は `haiku`、wiki 保守と提案は `sonnet`、上限は決めた額):
   ```sh
   node dist/src/cli.js evolve --tasks livemath/tasks-pilot.jsonl --out runs/livemath-pilot \
     --agent-prompt benchmarks/prompts/livemath.txt --task-desc "multiple-choice math problems" \
     --model sonnet --infer-model haiku --iters 2 --runs 1 --concurrency 2 --max-cost 8
   ```
4. 終了時に、次のような行が出ます。**この数字をコンパスに伝えてください**(または `runs/livemath-pilot/manifest.json` の `usage`)。
   ```
   [wikiskill] usage: N calls, $X.XX as reported by the claude CLI (infer 106 calls $…, wiki 2 calls $…, propose 2 calls $…)
   ```
5. 中断した場合(上限に達した、枠が尽きた、など): 同じコマンドに `--resume` を付けると、続きから再開します。上限を上げる場合は `--max-cost` を変えます。
6. 結果の確認: `node dist/src/cli.js check --run runs/livemath-pilot` が `OK` になること。`manifest.json` の `quality` が両方 0 であること。
7. パイロットで見るもの: ①ベースラインの検証スコア(スキルなし) → 進化後のスコアが上がるか、②ゲートの却下が起きたか(`wiki/skill-impact.md` に `Rejected`)、③エラー(`quality`)が出ていないか。

## HOWTO 5: 実測から本番の費用を見積もる
✅ 計算式は検証済み(`manifest.json` の `usage.by_role` から取れる値を使用)。

1. パイロットの `manifest.json` の `usage.by_role` から、役割ごとの平均を出す:
   - 推論(`infer`)の1呼び出しあたり = `by_role.infer.usd ÷ by_role.infer.calls`
   - 保守・提案(`wiki`、`propose`)の1呼び出しあたり = それぞれ同様
2. 本番の呼び出し数(LiveMath、K=8、3回): 
   - 推論 = 3 × (V + K×(T+V) + 2×N_test) = 3 × (18 + 8×53 + 2×124) = **2,070**
   - 保守 = 3 × K = **24**、提案 = 3 × K = **24**
3. 見積もり = 2,070 × (推論の平均) + 24 × (保守の平均) + 24 × (提案の平均)。早期終了(検証が 1.0 になる)があれば、これ以下です。
4. この見積もりをあなたが見て、**本番の上限(USD)**を決めて承認します。

## HOWTO 6: 本番を実行する(3回を1回ずつ)
⚠️ 承認後。コマンドの形式は検証済み(✅)。

3回を1回ずつ、別の日に分けて実行できます(利用枠が足りない場合に有効)。

1. 作業ツリーがきれいなこと(`git status --porcelain` が空)。
2. 1回目:
   ```sh
   node dist/src/cli.js evolve --tasks livemath/tasks.jsonl --out runs/livemath/run-1 --run-label run-1 \
     --agent-prompt benchmarks/prompts/livemath.txt --task-desc "multiple-choice math problems" \
     --model sonnet --infer-model haiku --iters 8 --concurrency 2 --max-cost <この1回の上限>
   ```
3. 2回目・3回目は `--out runs/livemath/run-2 --run-label run-2`、`run-3` で同様に実行します。
4. 中断したら、同じコマンドに `--resume` を付けて、その run だけ再開します(`--runs 3` との併用はできません)。
5. 3回が終わったら、親フォルダで検査します:
   ```sh
   node dist/src/cli.js check --run runs/livemath       # run-1, run-2, run-3 を順に検査
   node dist/src/cli.js rescore \
     --predictions runs/livemath/run-1/results/predictions.jsonl \
     --predictions runs/livemath/run-2/results/predictions.jsonl \
     --predictions runs/livemath/run-3/results/predictions.jsonl
   ```
6. `FAIL` が出たら、その run は使えません。原因は `problem:` に書かれています([トラブルシューティング](#6-トラブルシューティング))。

## HOWTO 7: アブレーションを実行する
⚠️ 実装は論文の構成(Wiki Maintainer も外す)に合わせ済み。**実機での実行は未実施**です。

本番と**同じ分割・同じモデル・同じ K**で、`--proposer-no-wiki` を付けて別のフォルダに出力します。

```sh
node dist/src/cli.js evolve --tasks livemath/tasks.jsonl --out runs/livemath-nowiki/run-1 --run-label run-1 \
  --agent-prompt benchmarks/prompts/livemath.txt --task-desc "multiple-choice math problems" \
  --model sonnet --infer-model haiku --iters 8 --concurrency 2 --proposer-no-wiki --max-cost <上限>
```

- `run-2`、`run-3` も同様に。`manifest.json` の `options.proposer_sees_wiki` が `false` になります。
- 論文の「推論側にも wiki を読ませる」実験は `--inference-wiki`(訓練ロールアウトのみ)です。
- 本番との比較は、`rescore` に両方の `predictions.jsonl` を渡し、`condition` が同じ `evolved` になって混ざらないよう、**別々に集計**してください(フォルダごとに実行)。

## HOWTO 8: 受け取るチームへ引き渡す
✅ `check` と `rescore` は検証済み。梱包の手順は手順どおりに動作する想定(⚠️ 圧縮の部分は未実行)。

1. 引き渡す run が、**コミット済みのコード**から作られていること: 各 run の `manifest.json` で `environment.tool.git_dirty` が `false`。
2. すべての run が `check` を通ること:
   ```sh
   node dist/src/cli.js check --run runs/livemath
   ```
3. 梱包とハッシュ(別の経路で控えておくと、受け取り後の取り違えを検出できます):
   ```sh
   tar -czf livemath-handoff.tgz -C runs livemath
   shasum -a 256 livemath-handoff.tgz
   ```
4. 一緒に渡すもの: 上の `.tgz`、WikiSkill のコミット(`manifest.json` の `git_commit`)、[`HANDOFF.md`](HANDOFF.md)、**`output` の再配布の可否の判断**(あなたが判断します。`output` にはモデルの推論過程が含まれ、メールアドレス形式だけが伏せてあります)。
5. 受け取るチームには、`HANDOFF.md` の §2(受け取ったらまずやること)から始めてもらいます。

## HOWTO 9: (任意)ローカルモデルで推論を回す
⚠️ **未検証**。接続口は実装済み(模擬サーバーでのテストのみ)、この Mac では Ollama が起動中ですが、入っているのは埋め込みモデル(`nomic-embed-text`)だけで、チャット用モデルは未導入です。

狙い: 呼び出しの約97%を占める推論をローカルで動かし、Claude の利用枠を、wiki 保守と提案の約50回だけにする。論文もオープンモデルを使っています。**制約**: テキストのみ(ツールなし)なので、LiveMath には使えますが、ツールが要るベンチマークには使えません。

1. Ollama が起動していること:
   ```sh
   curl http://localhost:11434/v1/models
   ```
2. チャット用モデルを導入する(モデル名は例。大きさはメモリに合わせて選ぶ。ダウンロードが発生します):
   ```sh
   ollama pull <モデル名>
   ```
3. **まず小さな確認**(Claude を消費しません)。見本の run のスキルを、ローカルモデルで採点します:
   ```sh
   node dist/src/cli.js eval --tasks examples/tasks-hidden-rule.jsonl --split test \
     --skills ref=examples/reference-run/skills \
     --infer-backend openai --base-url http://localhost:11434/v1 --infer-model <モデル名>
   ```
   正解率が表示されれば、接続は成功です。
4. 本番は、`evolve` に `--infer-backend openai --base-url http://localhost:11434/v1 --infer-model <モデル名>` を足します(`--model` は wiki 保守と提案の Claude モデル)。
5. 注意: ローカルモデルでは、論文の数値と比較するモデルが変わります([`REPRODUCTION.md`](REPRODUCTION.md) の D1、D6)。結果には、使ったモデルを明記してください。

## HOWTO 10: (後続)ほかのベンチマークの追加準備
後続フェーズです。必要なものだけを挙げます(詳細は [`REPRODUCTION.md`](REPRODUCTION.md) §6)。

| ベンチマーク | あなたが用意するもの | コンパスが用意するもの |
|---|---|---|
| OfficeQA | データ(財務省月報のテキスト)と分割 | 数値の比較ルールの採点コマンド(許容誤差の規則は論文に記載なし) |
| SpreadsheetBench | データ(入力のスプレッドシート)と分割 | 出力ファイルを比較する採点コマンド(`$WIKISKILL_WORKSPACE` から読む)。作業ファイルに依存するため、`rescore` では再採点できない点に注意 |
| SealQA | 2026年7月版のデータと分割、**検索 API のキー**(論文は Google Search API) | 検索ツールのアダプタ(MCP)。Claude の組み込み検索とは別物で、差が出る |
| ALFWorld | — | **v1 の対象外** |

課題ごとのファイルの付け方は、`tasks.jsonl` の `workspace` フィールド(`--help` の末尾)に書かれています。採点コマンドの書き方は [`HANDOFF.md`](HANDOFF.md) §5 です。

---

## 6. トラブルシューティング
✅ メッセージはどれも実装済みのもの(テストあり)。

| 表示 | 意味 | 対処 |
|---|---|---|
| `already holds a WikiSkill run` | その `--out` に前回の run がある | 続きなら `--resume`、やり直しなら `--force`、別の run なら別の `--out` |
| `contains files that are not from a WikiSkill run` | `--out` に、無関係なファイル(自分の `skills/` など)がある | **何も消されていません。** 空のフォルダを `--out` に指定する |
| `--resume cannot be combined with --runs > 1` | 複数回実行の再開はできない | run を1つずつ(`--out …/run-N --run-label run-N`)実行して再開する |
| `agent calls failed … stopping` | 大半のエージェント呼び出しが失敗(レート制限・タイムアウト・枠切れ) | 枠が回復してから `--resume`。失敗を不正解として記録し続けないために止めています |
| `spending cap of $X reached` | `--max-cost` の上限に到達 | 費用を確認して、`--max-cost` を上げて `--resume` |
| `check` が `agent call(s) failed … were scored as wrong` | 失敗が残った run | その run は使えない。原因を直して、やり直す |
| `check` が `skills/ does not match manifest.skills: <名前> (changed)` | run の後に、スキルが書き換えられた | 書き換えを戻す。戻せなければその run は使えない |
| `field "…" is missing`(`make-tasks`) | テンプレートが、データにない欄を指している | 欄の名前を確認する |
| `split must be "train", "val" or "test"` | 課題ファイルの `split` の綴り違い | 綴りを直す(黙って捨てられるのを防ぐための検査) |
| 実行が極端に遅い・止まる | 利用枠の切れ、または `--concurrency` が大きすぎる | `/usage` を確認。`--concurrency 1〜2` にする |

## 7. 決めてほしいこと

| # | 決めること | コンパスの案 | 理由 |
|---|---|---|---|
| 1 | LiveMath のデータと分割の入手先 | (あなたが探す。見つからなければ著者へ問い合わせ) | 論文は分割を先行研究と一致させている。推測で作らない |
| 2 | パイロットの上限(USD)と、実行してよいか | `--max-cost 8` 程度から | 実測してから本番の予算を決める |
| 3 | 使うモデル | 推論 `haiku`、wiki 保守・提案 `sonnet` | 呼び出しの大半は推論。費用を抑えつつ、保守・提案は能力が要る |
| 4 | プランの扱い | まずパイロットを現プランで | Pro では全実行は現実的でない見込み。Max への変更または API 従量課金は、実測後に判断 |
| 5 | ローカルモデルを試すか | 余裕があれば(HOWTO 9) | Claude の枠を大幅に節約できる。論文の構成にも近い。ただし未検証でダウンロードが要る |
| 6 | 受け取るチームの要望(形式など) | 現在の形式(`schema_version: 1`)のまま | 変更は互換を保つ追加のみ。要望があれば早めに |
| 7 | `output` の再配布の可否 | あなたが判断 | 推論過程を含む |
