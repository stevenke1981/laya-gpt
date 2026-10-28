# laya-gpt — 單一 GPT 模型、本機 laya 決定 effort、長任務不亂停

> 只用一個模型（預設 GPT-6.1 Terra），每次 generation 由**本機 laya** 在 low～xhigh 之間決定 reasoning effort（新 turn 預設 medium），
> 並在模型「話說到一半就收工」時把任務接回來做完。

本專案衍生自 [jev-gpt](https://github.com/stevenke1981/jev-gpt)（871082f）。差異：

| | jev-gpt | laya-gpt |
|---|---|---|
| 決策模型 | OpenRouter 上的 `typesafe/jev-1.14`（需金鑰、按次計費） | **本機 [laya-deploy](https://github.com/stevenke1981/laya-deploy)**（`127.0.0.1:8100`，免金鑰，每次約 40–300 ms） |
| 問法 | `score`／`noul`，state 為整段軌跡 | **laya decision mode**：state 只放一句被判斷的主體、全用 `choice`、無 catch-all、門檻由程式持有 |
| 信任方式 | 信心 ≥ 0.3 即採用 | **laya 受規則把關**：信心 < 0.5 棄權改用規則；turn 中 laya 只能調高 effort；停止判斷與規則取大 |
| 長任務 | 計畫提醒＋續跑（上限 3） | 同上，**上限 5**，另加「第一人稱承諾工作」規則（I will fix…／我會再修…） |
| 預設埠／home／Codex profile | 8789／`~/.jev-gpt`／`jevgpt` | **8790**／`~/.laya-gpt`／`layagpt` |

jev-gpt 與 laya-gpt 可同時執行。

## 快速開始（Windows PowerShell）

先裝好 [Node.js](https://nodejs.org/) ≥ 22.15、`git`、[uv](https://docs.astral.sh/uv/)（`powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`）與 Codex CLI，然後：

```powershell
git clone https://github.com/stevenke1981/laya-gpt.git
cd laya-gpt
npm link                                 # ← 必做：把 laya-gpt 註冊成指令；沒做會出現「無法辨識 'laya-gpt' 詞彙」
laya-gpt --version                       # 應顯示 laya-gpt v0.3.1
laya-gpt setup                           # 安裝本機 laya（約 3 GB＋模型約 650 MB，預設放 ~\.laya-gpt\laya-deploy）
#   想放其他磁碟：laya-gpt setup --dir E:\laya-deploy
laya-gpt install                         # 寫入 Codex profile
laya-gpt codex                           # 自動啟動 laya 與 proxy，再開 Codex
```

`npm link` 後仍找不到 `laya-gpt`：關掉並重開 PowerShell；仍不行就確認 `npm prefix -g` 顯示的資料夾在 PATH 裡。也可不註冊指令，直接執行 `node bin\laya.js <指令>`（例如 `node bin\laya.js setup`）。

## laya 由 laya-gpt 安裝與啟動

laya 本身是 Python（torch＋laya），放在獨立的 [laya-deploy](https://github.com/stevenke1981/laya-deploy) checkout；laya-gpt 負責安裝、啟動、停止它，自己仍零依賴。以下指令需先完成 `npm link`（見「快速開始」）。

```powershell
laya-gpt setup                          # 第一次：clone laya-deploy 到 ~/.laya-gpt/laya-deploy、uv sync（約 3 GB）、下載 multilingual（約 650 MB）
laya-gpt setup --dir E:\laya-deploy     # 指定安裝位置，或改用既有的 laya-deploy checkout（會記住此路徑）
```

需要 `git` 與 [uv](https://docs.astral.sh/uv/)；`--dir` 指向的資料夾須不存在、為空，或已是 laya-deploy checkout。`setup` 可重複執行（已 clone 則略過，只再 `uv sync` 與確認模型已下載）。之後 `laya-gpt serve`（或 `laya-gpt codex`）發現 8100 沒有 laya 時，會在背景以該 checkout 的 `.venv` Python 啟動 laya-deploy，並預先載入 laya-gpt 用的 checkpoint（`LAYA_DEPLOY_PRELOAD`），不等它載完——載入期間（約 10–40 秒）決策先用規則。`laya-gpt status` 顯示 laya 狀態；`laya-gpt stop` 會一併停掉**由 laya-gpt 啟動的** laya（手動啟動的不動）。`LAYA_AUTOSTART=off` 關閉自動啟動；`LAYA_DECISION_URL` 不是本機位址時也不會自動啟動。

laya 未啟動時 laya-gpt 照常運作：每次決策連線失敗即改用規則（`source` 會寫 `heuristic (laya failed: …)`），不擋住客戶端。laya 若卡住不回（例如 checkpoint 第一次載入約 40 秒），一次逾時（`LAYA_DECISION_TIMEOUT_MS`，2 秒）後暫停呼叫 laya 30 秒，期間直接用規則，不再每次等逾時。

## Effort 如何決定

proxy 位於 Codex（或 Chat Completions 客戶端）與上游之間，每次 generation 前讀取本輪軌跡，向 laya 問一題（state 只有一句話）：

| 時機 | state | 問題（`choice`，選項即 effort 階梯） | 把關 |
|---|---|---|---|
| 新 turn | `{"request": "<使用者需求前 800 字>"}` | 這個需求要多少推理？low＝招呼／簡單問題、medium＝一般程式工作、high＝設計／跨模組重構／除錯根因、xhigh＝系統重設計／久攻不下的安全或並行問題 | laya 主導；最高機率 < 0.5 則棄權改用規則 |
| turn 中 | `{"last_step": "ran the tests or build, it failed; 2 failures in a row; the same failing command was repeated"}` | 下一步要多少推理？＋是否卡住（`stuck`／`progressing`） | laya **只能調高**：與規則取較高者，同級時沿用規則（含 hold）。laya 不擅長數失敗次數，故 laya 不能把 effort 調得比規則低（laya 勝出時 hold 改依其 `stuck` 機率） |

`last_step` 由程式把數字轉成少數固定片語（first failure／2 failures in a row／4 or more failures in a row／read 5 files since the last edit…），相同情境問相同問題。

規則（`src/policy.js`，laya 棄權或失敗時使用，也是 turn 中的下限）：新 turn 預設 medium，招呼 → low，困難／深入／超過 600 字 → high；turn 中例行步驟 → low，剛改程式或累積讀檔 → medium，連續失敗 → high／xhigh 並鎖定數步。一旦本輪被續跑過，之後 effort 不低於預設值。

改寫範圍：只改 effort（Responses 的 `reasoning.effort`；Chat 的 `reasoning_effort` 或 `reasoning.effort`），客戶端 model 為 `laya-auto`／`auto` 時另把 `model` 改成設定的模型 id。`instructions`、`tools` 與既有 `input` 不變，prompt cache 前綴維持命中；長任務協助只在**請求末端**附加訊息。

## 長任務協助：不讓 GPT-6.1 Terra 亂停

GPT-6.1 Terra 在長任務中常提早結束 turn：寫個摘要、說「接下來我會…」、或問「要我繼續嗎？」，但工作其實沒做完。

### 1. 計畫提醒（nudge，`LAYA_NUDGE=on`）

本輪計畫（Codex `update_plan`；Chat 另讀 `todowrite`／`TodoWrite`）還有未完成步驟時，每次 generation 前在請求末端附加提醒：已完成幾步、還剩哪些、全部做完並驗證前不要收工、不要停下來問是否繼續。

### 2. 提早收工自動續跑（resume，`LAYA_CONTINUE=on`）

適用於串流的 Responses 請求（Codex）。proxy 暫扣上游最後的 `response.completed`，若這一代沒有工具呼叫（要把控制權交還使用者）、本輪做過事或有計畫、續跑未達 `LAYA_MAX_CONTINUES`（預設 5），且 `unfinished` ≥ `LAYA_CONTINUE_THRESHOLD`（預設 0.6），就立刻帶著原請求＋剛才的輸出＋一則 `[laya]` developer 訊息再送一次，effort 提高一階（至少為預設值），新事件接在同一條串流上送回 Codex。

停止判斷（laya 模式，`src/decisions.js` 的 `layaStopCheck`）：

1. **硬規則先決，不問 laya**：本輪沒做事 → 0；向使用者索取只有他有的東西（API key、密碼、請提供、請先登入、哪一個…）→ 0.1；計畫有未完成步驟 → 0.9。
2. 否則把**收尾文字末 500 字**當 state（`{"closing": "…"}`），一次問兩題：
   - `end`：`will_continue`（打算或提議繼續同一任務）／`done`（說任務完成）／`needs_user`（要金鑰、密碼、登入或只有使用者能做的決定）
   - `work`：`in_progress`（部分完成、還有剩）／`complete`（全部完成並驗證）
3. `end` 選 `needs_user` → `unfinished` = P(will_continue)（合理停下，規則不加碼）；否則 `unfinished` = max(P(will_continue), P(in_progress), 規則分數)。規則分數：徵求許可的問句（would you like me to…?、要我…嗎）或第一人稱承諾（next I'll、I will fix…、接下來我會、我會再修…）0.75；最後一步失敗 0.5；其餘 0.1。「if you want, I'll add docs」「如果你需要，我會補上文件」這類提議不算。

laya 失敗時只用規則。`heuristic`／`llm` 模式只用規則；`off` 不續跑。

### 實測（`node scripts/laya-eval.mjs`，RTX 3060 Ti）

預設 checkpoint 自 v0.3.0 起為 **multilingual**（主人實際使用時 english 容易跑偏，尤其中文與混雜文字）。同一組 29 題：multilingual **26/29**、english 28/29。

| 項目 | multilingual | 說明 |
|---|---|---|
| 新 turn effort | 7/9 | 「hi there」給 medium（預期 low）；「重構整個認證架構並找出 session 競態的根因」給 xhigh 0.51（預期 high）——兩者都只是多花推理，不會少做 |
| turn 中 effort | 6/7 | 第一次失敗給 high（預期 medium），偏保守 |
| 停止判斷 | 13/13 | 加入「`end` 以 ≥ 0.9 判定已完成時忽略 `work` 的進行中」把關後；未加時，完成的條列摘要會被誤判續跑 |

以下為 v0.1 時 english 的分項：

| 項目 | 結果 | 說明 |
|---|---|---|
| 新 turn effort | 9/9 | 招呼、一般工作由 laya 判定（中英文皆對）；三個困難需求 laya 信心 0.37–0.40 而棄權，由規則判為 high |
| turn 中 effort | 6/7 | 唯一不同：第一次失敗 laya 給 high（預期 medium）——laya 只能調高，屬偏保守 |
| 停止判斷 | 13/13 | 含中英文「完成」「索取金鑰」「接下來我會」「要我繼續嗎」「Remaining: …」「I will fix those…」 |

另以真 proxy＋真 laya＋模擬上游端到端實測：模型回「前兩個模組已遷移完成，剩下三個模組我之後再處理。」（規則未命中）→ laya `in_progress 0.61` → 自動續跑一次、effort LOW → MEDIUM，客戶端只看到一個完整 turn。

終端機輸出範例：

```
Laya  LOW  ✓ APPLIED
     Step 2 · next 1 generation(s) · 215 ms · routine verify; laya low 0.52; stuck 0.20
Laya  RESUME #1 → MEDIUM  ✓ APPLIED
     Step 2 · unfinished 0.61 · laya · laya done 0.76, in progress 0.61
```

## 安裝與使用

需求：Node.js ≥ 22.15（零依賴）、Codex CLI 或任一 Chat Completions 客戶端；本機 laya 需 `git` 與 `uv`（選用但建議）。

```powershell
git clone https://github.com/stevenke1981/laya-gpt.git
cd laya-gpt                # 一定要在這個資料夾執行 npm link
npm link                   # 必做：註冊全域指令 laya-gpt（或改用 node bin/laya.js ...）
laya-gpt --version
laya-gpt setup             # 安裝本機 laya（見上節；已有 laya-deploy 用 --dir）
laya-gpt install           # 寫入 $CODEX_HOME/layagpt.config.toml（預設 ~/.codex）
```

`install` 寫入的 Codex profile：`model = "gpt-6.1-terra"`、`model_reasoning_effort = "medium"`、`layagpt` provider 指向 `http://127.0.0.1:8790/v1`、`wire_api = "responses"`、`requires_openai_auth = true`（沿用 Codex 既有登入）。檔案若存在且不是本工具寫入的，會拒絕覆寫，需加 `--force`。

```powershell
# A. 一鍵：背景啟動 proxy，再執行 codex -p layagpt
laya-gpt codex
laya-gpt codex exec "implement the plan in TODO.md and make the tests pass"

# B. 即時看決策：開兩個視窗
laya-gpt serve             # 視窗 1
codex -p layagpt           # 視窗 2
```

| 指令 | 用途 |
|---|---|
| `laya-gpt serve` | 前景執行 proxy（預設 `127.0.0.1:8790`） |
| `laya-gpt setup [--dir D]` | 安裝 laya-deploy（clone、`uv sync --extra model`、下載 checkpoint） |
| `laya-gpt install [--force]` | 寫入 `layagpt` profile |
| `laya-gpt install --global` | 另把 laya-gpt 設為 `config.toml` 的預設 provider（給 Codex 桌面版／IDE 擴充） |
| `laya-gpt uninstall` | 還原 `config.toml`、移除本工具寫的 profile |
| `laya-gpt codex [args...]` | 必要時啟動 proxy，再執行 `codex -p layagpt [args...]` |
| `laya-gpt tail` | 即時追蹤決策（讀 `decisions.jsonl`） |
| `laya-gpt stats` | 依 effort 分組統計 generation、reasoning tokens 與續跑次數 |
| `laya-gpt status` | 顯示執行中 proxy 的版本；過舊或未執行時 exit 1 |
| `laya-gpt stop` | 停止執行中的 proxy（只停 `app` 為 `laya-gpt` 者） |
| `laya-gpt --version` | 磁碟上程式碼的版本與 build |

### Codex 桌面版與 IDE 擴充

桌面版與 IDE 擴充無法帶 `-p`，只讀主設定檔 `$CODEX_HOME/config.toml`，故需 `--global`：

```powershell
laya-gpt install --global  # 第一次會備份成 config.toml.laya-gpt.bak
laya-gpt serve             # 保持開著；桌面版不會替你啟動 proxy
# 重開 Codex 桌面版，送一個請求；serve 視窗出現「Laya MEDIUM ✓ APPLIED」即表示已經過 proxy
laya-gpt uninstall         # 還原
```

`--global` 在 `config.toml` 最前面加入 `model_provider`、`model`、`model_reasoning_effort`，檔尾加入 `[model_providers.layagpt]`，皆夾在 `# >>> laya-gpt` 與 `# <<< laya-gpt` 標記之間；原本的同名頂層設定改為 `# laya-gpt saved: …` 註解，`uninstall` 逐字還原。注意：之後**所有** Codex 用戶端（含直接打 `codex`）都經過 proxy，proxy 沒開即連線失敗。桌面版若改走 websocket 傳輸，請求不經過 proxy（serve 視窗不會出現決策）——**桌面版尚未實測**。

**更新後請重啟 proxy**（`git pull` 後 `laya-gpt stop`）。`/laya/health` 回報 `app`、`version`、`build`、`pid`、`startedAt`、`mode`、`ladder` 與 `stats`（含 `byEffort`、`continued`、`nudged`）。`decisions.jsonl` 每筆另有 `nudged: true` 與 `continues: [{n, effort, unfinished, source, reasons}]`（有發生時）。

**上游與憑證**：`LAYA_UPSTREAM` 強制指定；ChatGPT 登入（JWT 或 `chatgpt-account-id`）→ `chatgpt.com/backend-api/codex`；`sk-or-` 金鑰 → `openrouter.ai/api/v1`；其他 → `api.openai.com/v1`。proxy 不寫入任何憑證到記錄；送給 laya 的只有需求前 800 字、一句步驟描述或收尾文字末 500 字，預設送往本機 laya；若改 `LAYA_DECISION_URL` 指向他處，這些文字與 `LAYA_API_KEY` 也會送往該處。

## Chat Completions 客戶端

proxy 也代理 `POST /v1/chat/completions`。opencode、aider、crush 把 base URL 指到 `http://127.0.0.1:8790/v1`，model 設 `laya-auto`。effort 路由與計畫提醒都適用；**自動續跑目前只支援 Responses 串流**（Codex）。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "laya": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "laya-gpt",
      "options": { "baseURL": "http://127.0.0.1:8790/v1", "apiKey": "{env:OPENAI_API_KEY}" },
      "models": { "laya-auto": { "name": "GPT-6.1 Terra (laya effort)" } }
    }
  }
}
```

```powershell
# OPENAI_API_KEY 原樣轉給上游；sk-or- 開頭的 OpenRouter 金鑰會自動走 OpenRouter
aider --openai-api-base http://127.0.0.1:8790/v1 --model openai/laya-auto
```

## 設定（環境變數）

| 變數 | 預設 | 說明 |
|---|---|---|
| `LAYA_PORT` / `LAYA_HOST` | `8790` / `127.0.0.1` | 監聽位址 |
| `LAYA_GPT_MODEL` | `gpt-6.1-terra` | 唯一的上游模型 id |
| `LAYA_AUTO_MODELS` | `laya-auto,auto` | 會改寫成上述 id 的客戶端 model 名稱 |
| `LAYA_LEVELS` | `low,medium,high,xhigh` | effort 階梯（亦即 laya 的選項） |
| `LAYA_DEFAULT_EFFORT` | `medium` | 新 turn 起點（規則），也是續跑後的下限；須在階梯內 |
| `LAYA_MODE` | `laya` | `laya`、`heuristic`（只用規則）、`llm`（小模型判官）、`off`（純轉送） |
| `LAYA_DECISION_URL` | `http://127.0.0.1:8100/api/alpha/decisions` | laya-deploy Decisions API |
| `LAYA_DECISION_MODEL` | `multilingual` | laya checkpoint（`multilingual`、`english`、`auto`）；也是自動啟動時預先載入者 |
| `LAYA_AUTOSTART` | `on` | serve 時若本機 laya 沒在跑就啟動它 |
| `LAYA_DEPLOY_DIR` | `~/.laya-gpt/laya-deploy`（或 `setup --dir` 記住的路徑） | laya-deploy checkout |
| `LAYA_DEPLOY_PYTHON` | checkout 的 `.venv` Python | 改用其他 Python 啟動 laya-deploy |
| `LAYA_API_KEY` | — | laya-deploy 設了 `LAYA_DEPLOY_API_KEY` 時填同值 |
| `LAYA_DECISION_TIMEOUT_MS` | `2000` | 單次 laya 決策逾時（至少 1）；逾時後暫停 laya 30 秒 |
| `LAYA_MIN_CONFIDENCE` | `0.5` | laya 最高機率低於此值即棄權，改用規則 |
| `LAYA_CONTINUE` | `on` | 提早收工自動續跑 |
| `LAYA_MAX_CONTINUES` | `5` | 每個 turn 最多續跑次數 |
| `LAYA_CONTINUE_THRESHOLD` | `0.6` | `unfinished` 達此值才續跑 |
| `LAYA_NUDGE` | `on` | 計畫有未完成步驟時附加提醒 |
| `LAYA_JUDGE_MODEL` / `LAYA_JUDGE_EFFORT` / `LAYA_JUDGE_TIMEOUT_MS` | 請求模型 / `low` / `2500` | `llm` 判官 |
| `LAYA_UPSTREAM`、`LAYA_CHATGPT_UPSTREAM`、`LAYA_API_UPSTREAM`、`LAYA_OPENROUTER_UPSTREAM` | 依憑證 | 上游 |
| `LAYA_HOME` | `~/.laya-gpt` | `decisions.jsonl`、`proxy.log` |
| `LAYA_QUIET` | — | `1` 則不印決策 |
| `CODEX_HOME` | `~/.codex` | `install` 寫入目錄 |

## 架構

| 檔案 | 職責 |
|---|---|
| `src/config.js` | 環境變數與驗證 |
| `src/decisions.js` | laya 決策：`effortCall()`／`situation()`（state 與問題）、`layaDecide()`、`combineEffort()`（把關）、`layaStopCheck()` |
| `src/policy.js` | 規則判斷 `assess()`、hysteresis `nextState()` |
| `src/router.js` | 依 session 保存 effort 狀態與本輪續跑次數（`continuesOf`、`noteContinue`） |
| `src/longtask.js` | 計畫解析 `turnPlan()`、`finalOutput()`、規則版停止判斷 `assessStop()`、提醒與續跑訊息 |
| `src/splice.js` | SSE 事件切分、暫扣 `response.completed`、把續跑回應接在同一串流 |
| `src/trajectory.js` / `src/chat.js` | Responses／Chat 軌跡解析 |
| `src/judge.js` | 選用的 LLM 判官 |
| `src/model.js` | 模型 id、`laya-auto` 別名、effort 對齊 |
| `src/proxy.js` | HTTP proxy：解壓、改寫、提醒、續跑、usage、`/laya/health` |
| `src/log.js` / `src/version.js` | 決策記錄與格式；版本與 build 指紋 |
| `bin/laya.js` | CLI |
| `scripts/laya-eval.mjs` | 對執行中的 laya 量測上述問法（含把關） |

## 限制與未驗證事項

- **未驗證**：未以真實 Codex＋GPT-6.1 Terra 長任務實測；Codex 桌面版（`install --global`）未實測；`laya-gpt setup` 的全新安裝路徑（git clone＋uv sync 約 3 GB）未實跑，自動啟動／停止則已以既有 checkout 實測；續跑串流以本機模擬上游驗證（同 jev-gpt）。
- laya 實測案例僅 29 則，皆為短句；長篇、混雜程式碼的收尾文字之準確度未量測。請以 `laya-gpt stats` 與 `decisions.jsonl` 在自身工作量觀察，必要時調 `LAYA_CONTINUE_THRESHOLD`、`LAYA_MIN_CONFIDENCE`。
- 困難需求 laya 常信心不足而棄權（實測 0.37–0.40），此時由關鍵字規則決定。
- 回傳給客戶端的 `usage` 只含最後一個回應；續跑那一代的 tokens 也算在上游帳單裡。
- 停止判斷取 laya 與規則之大者：收尾若是請使用者核可（"I need your approval to continue"）而 laya 判為 in progress，仍可能續跑；續跑上限 `LAYA_MAX_CONTINUES` 為最後防線。
- Chat Completions 不續跑；Codex 的 websocket 傳輸不經過 proxy。

## 測試

```powershell
npm test                          # node --test；不連網路，上游與 laya 皆以本機 http.createServer 模擬
node scripts/laya-eval.mjs        # 需執行中的 laya：量測 effort 與停止判斷
```

## 變更歷史

| 版本 | 日期 | 內容 | 影響範圍 |
|------|------|------|----------|
| v0.1.0 | 2026-10-29 | 初始建立（衍生自 jev-gpt 871082f）：決策改由本機 laya（decision mode、choice 問題、規則把關）、預設 GPT-6.1 Terra medium、laya 選 low～xhigh、續跑上限 5、第一人稱承諾規則、CLI `laya-gpt`（埠 8790、profile `layagpt`） | 全部 |
| v0.1.1 | 2026-10-29 | 依獨立審查修正：句尾條件式提議（"I'll add docs if you want"、「你想要的話我會改」）不再算承諾；承諾規則改為有界視窗（避免長文字二次方耗時）；laya 逾時後暫停 30 秒；`LAYA_DECISION_TIMEOUT_MS` 須 ≥ 1；README 更正 | `longtask.js`、`decisions.js`、`config.js`、README |
| v0.2.0 | 2026-10-29 | `install --global`：改寫 `config.toml`（可逆、自動備份）讓 Codex 桌面版／IDE 擴充也經過 proxy；新增 `uninstall` | `bin/laya.js`、`src/codexconfig.js`、README |
| v0.3.0 | 2026-10-29 | 整合 laya-deploy：`laya-gpt setup` 安裝、`serve` 自動啟動（預載所用 checkpoint）、`stop` 一併停止、`status` 顯示 laya；預設 checkpoint 改為 multilingual；停止判斷加「end 確定已完成則忽略 work」把關 | `src/layaserver.js`、`bin/laya.js`、`src/config.js`、`src/decisions.js`、README |
| v0.3.1 | 2026-10-29 | README：新增「快速開始」，強調 clone 後須先 `npm link`、列出 git／uv 前置需求、`setup --dir` 指定安裝位置與指令找不到時的排解 | README |
