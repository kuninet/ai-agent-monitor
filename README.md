# AI Agent Monitor

Claude Code、Codex、Antigravity CLI(`agy`)の稼働状況を、ローカルのログから集計して表示するダッシュボードです。

![画面の例(架空のデータ)](docs/screenshot.png)

- API 換算額、キャッシュ読込率、ツールエラー率、文脈の圧縮、自動続行、作業時間、タスク、未回答の質問を KPI として表示します
- サブスクリプションの使用枠(5 時間枠・週次枠)と、セッションごとのコンテキスト使用率・開始時刻・作業時間を表示します
- セッション、サブエージェント、タスク(ID・状態・タイトル・Blocker)、未回答の質問を表で一覧できます
- セッションの行をクリックすると、タスクと未回答の質問をそのセッションの分だけに絞り込めます
- 監視するエージェントは、画面右上の ⚙ から選べます
- 端末管理アプリ Orca で動かしているセッションなら、行の ↗ ボタンでその端末タブに切り替えられます

API キーやネットワーク接続は使いません。手元に残るログを読むだけで、ログへの書き込みもしません。

## 必要なもの

- Node.js 22.13 以上(24 で動作確認)
- macOS または Linux(WSL2 を含む)
  - プロセス情報の取得に `ps` を使っています。Linux では procps(procps-ng)版の `ps` が必要です(Ubuntu や Debian などは標準)
- 依存パッケージはありません

WSL2 で使うときは次の点に注意してください。

- WSL 側で動かしているエージェントのログだけを集計します。Windows ネイティブで動かしているエージェントのログは読みません
- 画面は Windows 側のブラウザから `http://127.0.0.1:4777/` で開けます(WSL2 の localhost 転送が有効な場合)
- WSL のターミナルをすべて閉じると、しばらくして WSL ごとダッシュボードも止まります

## 起動

```sh
npm start
```

`http://127.0.0.1:4777/` を開きます。画面は 5 秒ごとに更新されます。

```sh
node src/server.js --port 4800            # ポートを変える
node src/server.js --json --range 7d      # 集計結果を JSON で出力して終了
```

`--range` は `today` / `24h` / `7d` / `30d` / `all`、`--agent` は `all` / `claude` / `agy` / `codex` です。

```sh
node src/server.js --agents claude,codex  # 監視するエージェントを指定する(画面の設定より優先)
```

## 監視するエージェントの選択

画面右上の ⚙ から、監視するエージェントを選べます。選んだ内容は `~/.ai-status/config.json` に保存され、次回の起動でも使われます。外したエージェントのログは読みません。

設定が無いときは、ログのディレクトリがあるエージェントをすべて監視します。起動オプション `--agents` を指定した場合はそちらが優先され、画面からは変更できません。

## 使用枠(5 時間枠・週次枠)を表示する設定

使用枠の値は statusline に渡される JSON にしか含まれないため、保存する設定が要ります。

### Claude Code

statusline のスクリプトで、入力を読み込んだ直後に次の 1 行を足してください。

```sh
input=$(cat)

{ SID=$(printf '%s' "$input" | jq -r '.session_id // empty') && [ -n "$SID" ] && mkdir -p "$HOME/.ai-status/claude" && printf '%s' "$input" > "$HOME/.ai-status/claude/$SID.json"; } 2>/dev/null || true
```

`jq` が必要です。この設定が無くても、使用枠以外の項目は表示されます。

### Codex

設定は不要です。使用枠は会話記録に含まれています。

### Antigravity CLI

設定は不要です。agy が書き出す `~/.gemini/antigravity-cli/last_statusline_input.json` を、ダッシュボードの起動中に会話ごと `~/.ai-status/agy/` へ保存します。そのため使用量とコンテキスト使用率が出るのは、ダッシュボードが起動している間に statusline が更新された会話だけです。

## 読み込むファイル

| 対象 | 場所 |
|---|---|
| Claude Code の会話記録 | `~/.claude/projects/**/*.jsonl`(サブエージェントを含む) |
| Claude Code の実行中セッション | `~/.claude/sessions/*.json` |
| Claude Code のタスク | `~/.claude/tasks/` と会話記録内の `TaskCreate` / `TaskUpdate` / `TodoWrite` |
| Codex の会話記録 | `~/.codex/sessions/**/rollout-*.jsonl` |
| Codex のスレッド一覧 | `~/.codex/state_*.sqlite` |
| agy の会話記録 | `~/.gemini/antigravity{,-cli}/brain/<id>/.system_generated/logs/transcript.jsonl` |
| agy のタスク | `~/.gemini/antigravity{,-cli}/brain/<id>/task.md` |
| agy の会話一覧 | `~/.gemini/antigravity{,-cli}/conversation_summaries.db` |

書き込むのは `~/.ai-status/` の中だけです。画面で選んだエージェントを `config.json` に保存します。agy の statusline 入力を会話ごとに保存し、メールアドレスは保存前に取り除きます。Claude Code 用に statusline へ上の 1 行を足した場合は、その入力が `~/.ai-status/claude/` に保存されます。

各指標の定義と判定ルールは [docs/DESIGN.md](docs/DESIGN.md) にまとめています。

## 注意

- API 換算額は、会話記録のトークン数に API の公開単価を掛けた概算で、請求額ではありません。サブスクリプションで使っている場合は、⚙ からプランの月額を設定すると「今月の換算額が月額の何倍か」を表示します。会話記録に残らない呼び出しもあるため、実際より少なめに出ることがあります
- Codex と agy は定額制のため API 換算額を出さず、使用枠を表示します
- Codex は 1 つのプロセスが複数の会話を扱うため、実行中かどうかは会話記録の更新から推定しています。デスクトップアプリや VS Code 拡張が起動している間は、閉じた会話も最後の更新から 30 分間は「入力待ち」と表示されます
- 作業時間は、会話記録の時刻から推定した、エージェントが作業していた時間です。人の入力待ちや放置の時間は含めません。記録が 30 分を超えて途切れた間(承認待ちや、出力を出さずに長く動く処理)は数えず、30 分未満の承認待ちは作業時間に含まれます
- 会話記録の形式はどのツールでも公開仕様ではありません。バージョンによって表示が崩れることがあります
- サーバーは `127.0.0.1` にだけ bind します。会話のタイトルや質問文を表示するので、外部に公開しないでください

## ライセンス

MIT
