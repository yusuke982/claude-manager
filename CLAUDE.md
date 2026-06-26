# ClaudeManager — プロジェクト指示書

`~/.claude` を読み書きして、スキル・サブエージェント・プロジェクト・セッション・ルーチン・MCP連携を1画面で管理するローカルWebアプリ。Claude Code 導入済み環境向け。

---

## 場所と起動

- **パス**: （任意のローカルディレクトリ）（git管理済み・npm名 `cc-manager`）
- **ポート**: 4317（固定）
- **スタック**: Node.js + Express + 単一HTML（バニラJS）。Viteなし・ビルドなし。

```bash
node server.js                        # localhost のみ（安全）
node server.js --host :: --open       # LAN/Tailscale公開（トークン自動発行）
node server.js --port 5000 --token xx # カスタムポート＋トークン指定
```

---

## ファイル構成

```
cc-dashboard/
├── server.js        Express サーバー（~/.claude 読み書き + claude CLI 実行）
├── public/
│   └── index.html   バニラJSの単一ファイルUI
├── package.json     bin: cc-manager → server.js
└── CLAUDE.md        本ファイル
```

---

## 実装済みAPI一覧（現在 v0.1.x）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/skills` | `~/.claude/` 配下のスキルMD一覧 |
| GET | `/api/agents` | `~/.claude/agents/` サブエージェント一覧 |
| GET | `/api/projects` | `~/.claude/projects/` プロジェクト一覧（概要/ロードマップ/課題/メモリ/セッション数） |
| GET | `/api/project-activity` | プロジェクト別アクティビティタイムライン（`?key=` 指定） |
| GET | `/api/sessions` | `~/.claude/sessions/` セッション一覧 |
| GET | `/api/session` | セッション詳細（`?id=` 指定） |
| POST | `/api/session/resume` | `claude --resume <id> -p` でセッション再開 |
| GET | `/api/stats` | 統計（dailyActivity・totals・settings概要） |
| GET | `/api/mcp` | MCPサーバー一覧（`claude mcp list`) |
| POST | `/api/mcp/add` | MCPサーバー追加（`claude mcp add`) |
| GET | `/api/routines` | スケジュールルーチン一覧（バックグラウンドエージェント代替） |
| GET | `/api/file` | ファイル読み取り（`~/.claude` 配下 + CLAUDE.md のみ） |
| PUT | `/api/file` | ファイル保存（`.bak` 退避あり） |
| DELETE | `/api/file` | ファイル削除（`.bak` 退避あり） |
| GET | `/api/config` | `~/.claude/settings.json` / `settings.local.json` 読み取り |
| POST | `/api/create` | スキル・エージェントファイル新規作成 |
| DELETE | `/api/project` | プロジェクトメモリ削除 |
| POST | `/api/assistant` | `claude -p` でアシスタント送信（レート消費） |
| POST | `/api/translate` | `claude -p` で日本語翻訳（サーバー側キャッシュあり） |

---

## UIセクション（サイドバータブ）

| タブ | 内容 |
|---|---|
| ダッシュボード | 利用統計・稼働グラフ・設定概要・MCPステータス |
| スキル | スキルMDカード一覧・ファイルエディタ |
| エージェント | サブエージェントカード一覧・ファイルエディタ |
| プロジェクト | コンパクトカード一覧 → 詳細LP（概要/ロードマップ/課題/メモリ/アクティビティ） |
| セッション | セッション一覧・詳細・再開ボタン |
| ルーチン | バックグラウンドエージェント一覧・最終実行時刻 |
| MCP | MCPサーバー一覧・詳細・アシスタント経由追加 |

---

## Claude枠（レート）の扱い（厳守）

- **枠を使わない**: 閲覧・一覧・件数・`claude agents/mcp list`
- **枠を消費する**: `claude -p` 実行系（アシスタント・セッション再開・MCP追加・翻訳）
- 翻訳トグルは既定OFF（ユーザー操作時だけ実行・サーバー側キャッシュ）
- アシスタントの既定モデルは Haiku
- 新機能で `claude -p` を足す時は「自動で走らない・ユーザー操作で1回だけ」を守る

---

## セキュリティ

- 既定: localhost バインド（ループバックは無条件許可）
- `--host` で外部公開時はトークン必須（未指定なら自動発行）
- ファイル読み書きは `~/.claude` 配下と `CLAUDE.md` のみ（任意パス読み出し不可）
- 保存・削除時は `.bak` 退避

---

## 作業の進め方（厳守）

- **軽量運用**: ツール呼び出しを最小化。検証は原則 `curl` 1回。
- スクリーンショットはレイアウト崩れ等の目視必須時のみ。
- 静的HTML変更はリロードで反映（サーバー再起動不要）。`server.js` 変更時のみ再起動。
- **UIは日本語**・**絵文字なし**・Claude純正アプリ調（暖色ペーパー＋コーラル、サイドバー＋右下オペレーター）
- 変更後は `node -e` でHTML内スクリプトの構文チェックを1回

---

## ロードマップ

### Stage 1 — ローカルNode（現在 v0.1.x）

**実装済み**
- [x] スキル・エージェント一覧（カード形式）
- [x] ファイルエディタ（読み・書き・削除、.bak退避）
- [x] スキル・エージェント新規作成
- [x] プロジェクト一覧（コンパクトカード → 詳細LP）
- [x] プロジェクト詳細LP（概要・ロードマップ・課題・メモリ・アクティビティ）
- [x] プロジェクトメモリ表示・削除
- [x] セッション一覧・詳細・再開
- [x] ルーチン一覧（最終実行時刻）
- [x] MCP一覧・詳細・アシスタント経由追加
- [x] 統計（dailyActivity・稼働グラフ・settings概要）
- [x] アシスタントパネル（右下フローティング・Haiku）
- [x] 翻訳トグル（JA、サーバーキャッシュ）
- [x] モバイル対応（viewport固定・レスポンシブ）
- [x] セキュリティ（ループバック無条件許可・リモートトークン認証）
- [x] プロジェクトアクティビティタイムライン

**残タスク（Stage 1 完成に向けて）**
- [ ] スキルMD編集後の即時反映（保存後にリストを自動更新）
- [ ] メモリファイル一覧・編集UI（MEMORY.md インデックス表示）
- [ ] `settings.json` / `settings.local.json` の編集UI
- [ ] セッション検索・絞り込み
- [ ] ルーチン手動実行ボタン

### Stage 2 — npm 公開（npx cc-manager）

- [ ] README 整備（スクリーンショット付き）
- [ ] `bin` エントリの動作確認（`npx cc-manager` 一発起動）
- [ ] バージョニング（1.0.0 リリースタグ）
- [ ] npm publish（public リポジトリ確認後）

### Stage 3 — 静的HTML + File System Access API

- [ ] サーバーレス化（Express不要）
- [ ] ブラウザの File System Access API で `~/.claude` を直接読む
- [ ] GitHub Pages / CDN で配布

---

## 既知の制約

- `/schedule` のクラウドルーチン本体はローカルに存在しない → ルーチン画面はバックグラウンドエージェント一覧で代替
- MCP OAuth認証はブラウザ操作が必要 → アシスタントが手順案内＋`claude mcp add` 自動実行まで対応
- `claude --resume` は対話セッションのため、headless実行では限定的な応答のみ取得可能

---

## OSS コントリビューション・ガイドライン (For Contributors)

本リポジトリにPull Requestを送る際は、以下のルールを遵守してください。

1. **アーキテクチャの制約 (軽量運用を維持すること)**
   - フロントエンドは**ビルド不要のVanilla JS・単一HTML**を維持してください。React/Vue/Viteなどの導入は行いません（Stage 3のCDN配布・サーバーレス化に向けた準備のため）。
   - パッケージの依存関係は最小限（現状は `express` のみ）に留めてください。

2. **機能追加のポリシー (Claude API・レート制限への配慮)**
   - 画面を開いただけで自動的にAPIリクエスト（`claude -p` 等を通じた通信）が走るような実装は**厳禁**です。API実行は必ずユーザーの明示的なアクション（ボタンクリックなど）をトリガーとしてください。
   - 既存のローカルファイル（`~/.claude/`）の読み取りで完結する機能追加を優先してください。

3. **セキュリティの遵守**
   - サーバーサイド（`server.js`）でファイルの読み書きを行う際は、必ず `isWritable()` 関数等を利用し、アクセス可能なディレクトリを `~/.claude` 配下および `CLAUDE.md` に制限してください。任意のローカルファイルが読み書き可能になる脆弱性を生んではなりません。

4. **UIのトーン＆マナー**
   - 言語は**日本語**に統一してください。
   - **絵文字は使用しないでください**。
   - Claude純正アプリのトーン（暖色ペーパー＋コーラル、クリーンなデザイン）を踏襲してください。
