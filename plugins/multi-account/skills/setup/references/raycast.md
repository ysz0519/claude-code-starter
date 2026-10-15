# 任意: Raycast のホットキーで起動する

Raycast を使っているなら、Script Command を2本置いてホットキーを割り当てると切り替えが速くなる。
**必須ではない**（`claude2` をターミナルで打つだけでも同じ）。

## 1. スクリプト置き場を用意して Raycast に登録

```bash
mkdir -p ~/.raycast-scripts
```

Raycast → Settings → Extensions → **Script Commands** → *Add Directories* で `~/.raycast-scripts` を追加する。

## 2. 2つ目のアカウントで Claude Code を開く

`~/.raycast-scripts/claude2-launch.sh`（`chmod +x` を忘れずに）

```bash
#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Claude2 (2nd account)
# @raycast.mode silent
# @raycast.icon 🔄
# @raycast.packageName Claude Code
# @raycast.description 2つ目の Claude アカウントで Claude Code を新しいウィンドウで起動する

# Terminal.app はログインシェルで ~/.zshrc を読むので、claude2 関数がそのまま使える
osascript <<'APPLESCRIPT'
tell application "Terminal"
  activate
  do script "claude2"
end tell
APPLESCRIPT
```

## 3. 専用 Chrome を開く

`~/.raycast-scripts/chrome2-launch.sh`

```bash
#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Chrome2 (2nd account)
# @raycast.mode silent
# @raycast.icon 🌐
# @raycast.packageName Claude Code
# @raycast.description 2つ目のアカウント専用の Chrome を起動する

bash "$HOME/.claude-accounts/account2/chrome/launch-chrome.sh"
```

`claude2` は未起動時に専用 Chrome を自動で立ち上げるので、こちらは Chrome だけ先に開きたいとき用。

## 4. ホットキーを割り当てる

Raycast の Script Commands 一覧から各コマンドを選び、Hotkey を設定する。

## 番号を変える場合

3つ目以降は `claude2` → `claude3`、`account2` → `account3` に読み替える。
