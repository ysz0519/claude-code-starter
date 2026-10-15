#!/bin/bash
# claude-multi-account 共通ライブラリ（source 専用）
# macOS / bash 3.2 互換で書く（連想配列・GNU 拡張は使わない）

set -o pipefail

CMA_DRY_RUN="${CMA_DRY_RUN:-0}"
CMA_EXT_ID_DEFAULT="fcoeoabgfenejglbffodgkkbkcdhcgfn"

cma_info() { printf '  %s\n' "$*"; }
cma_ok()   { printf '  ✅ %s\n' "$*"; }
cma_warn() { printf '  ⚠️  %s\n' "$*" >&2; }
cma_step() { printf '\n▶ %s\n' "$*"; }
cma_die()  { printf '❌ %s\n' "$*" >&2; exit 1; }

# dry-run 対応の実行ラッパー。第1引数は人間向けの説明。
cma_act() {
  local desc="$1"; shift
  if [ "$CMA_DRY_RUN" = "1" ]; then
    printf '  [dry-run] %s\n' "$desc"
    return 0
  fi
  "$@" || cma_die "失敗: $desc"
  printf '  ✅ %s\n' "$desc"
}

# config dir から Claude Code が使う Keychain サービス名を算出する。
# Claude Code はデフォルト以外の CLAUDE_CONFIG_DIR に対し
# "Claude Code-credentials-<config dir パスの sha256 先頭8桁>" を使う。
cma_keychain_service() {
  local cfg="$1"
  printf 'Claude Code-credentials-%s' "$(printf '%s' "$cfg" | shasum -a 256 | cut -c1-8)"
}

# Keychain にそのプロファイルの login があるか（値は読まない・存在確認のみ）
cma_has_keychain_login() {
  security find-generic-password -s "$(cma_keychain_service "$1")" >/dev/null 2>&1
}

# テンプレートを描画して標準出力に出す。
#   cma_render <template> <KEY> <VALUE> [<KEY> <VALUE> ...]
# KEY は __FOO__ 形式のトークン名（両端の __ を含めて渡す）。
#
# 置換は awk + ENVIRON による **完全リテラル置換**で行う。理由:
#   - bash の ${var//pat/repl} は 5.2 以降、置換文字列中の & がマッチ文字列に展開される
#     （5.1 以前は素通し）。置換値に && や >&2 を含むとバージョン差で壊れる
#   - sed も & と / のエスケープが要る／awk -v は \ を解釈してしまう
#   - ENVIRON 経由なら escape 処理が一切入らない
cma_render() {
  local tmpl="$1"; shift
  [ -f "$tmpl" ] || cma_die "テンプレートが見つかりません: $tmpl"
  local content
  content="$(cat "$tmpl")"
  while [ "$#" -ge 2 ]; do
    content="$(printf '%s\n' "$content" | CMA_K="$1" CMA_V="$2" awk '
      BEGIN { k = ENVIRON["CMA_K"]; v = ENVIRON["CMA_V"]; kl = length(k) }
      {
        line = $0; out = ""
        while (kl > 0 && (p = index(line, k)) > 0) {
          out = out substr(line, 1, p - 1) v
          line = substr(line, p + kl)
        }
        print out line
      }')" || cma_die "テンプレート置換に失敗: $tmpl ($1)"
    shift 2
  done
  printf '%s\n' "$content"
}

# 内容を指定パーミッションで書き出す（dry-run 対応）。
#   cma_write_file <path> <mode> <content>
cma_write_file() {
  local path="$1" mode="$2" content="$3"
  if [ "$CMA_DRY_RUN" = "1" ]; then
    printf '  [dry-run] 書き込み: %s (mode %s, %s 行)\n' \
      "$path" "$mode" "$(printf '%s\n' "$content" | wc -l | tr -d ' ')"
    return 0
  fi
  mkdir -p "$(dirname "$path")" || cma_die "ディレクトリ作成に失敗: $(dirname "$path")"
  printf '%s\n' "$content" > "$path" || cma_die "書き込みに失敗: $path"
  chmod "$mode" "$path" || cma_die "chmod に失敗: $path"
  printf '  ✅ 書き込み: %s (mode %s)\n' "$path" "$mode"
}

# symlink を辿って実体パスを返す（macOS の readlink には -f が無いため自前で辿る）。
# dotfiles 管理（~/.zshrc -> ~/dotfiles/zshrc）を壊さないために使う。
cma_realpath() {
  local p="$1" target n=0
  while [ -L "$p" ] && [ "$n" -lt 20 ]; do
    target="$(readlink "$p")"
    case "$target" in
      /*) p="$target" ;;
      *)  p="$(dirname "$p")/$target" ;;
    esac
    n=$((n + 1))
  done
  printf '%s' "$p"
}

# 上書きしないバックアップ名を作る（同一秒に複数回呼ばれても衝突しない）
cma_backup_path() {
  local base candidate i=1
  base="$1.bak.$(date +%Y%m%d%H%M%S)"
  candidate="$base"
  while [ -e "$candidate" ]; do
    candidate="$base-$i"
    i=$((i + 1))
  done
  printf '%s' "$candidate"
}

# シェル設定ファイル内のマーカーブロックを差し替える（無ければ末尾に追記）。
# マーカー: "# >>> claude-multi-account (<id>) >>>" 〜 "# <<< claude-multi-account (<id>) <<<"
#   cma_upsert_block <rc_file> <id> <content>
cma_upsert_block() {
  local rc="$1" id="$2" content="$3"
  local start="# >>> claude-multi-account ($id) >>>"
  local end="# <<< claude-multi-account ($id) <<<"

  case "$content" in
    *"$start"*) : ;;
    *) cma_die "内部エラー: ブロック本文に開始マーカーがありません ($id)" ;;
  esac

  # 既存ブロックの整合性チェック（開始と終了の数が合わないファイルは触らない）。
  # 片方しか無い状態で除去すると、マーカー以降の既存設定を丸ごと消してしまう。
  local n_start=0 n_end=0
  if [ -f "$rc" ]; then
    n_start="$(/usr/bin/grep -cF "$start" "$rc" || true)"
    n_end="$(/usr/bin/grep -cF "$end" "$rc" || true)"
    if [ "$n_start" != "$n_end" ]; then
      cma_die "$rc のブロック ($id) が壊れています（開始 $n_start 個 / 終了 $n_end 個）。
    手で対になるよう直すか、該当ブロックを削除してから再実行してください。
    既存の設定を消す恐れがあるため、ここでは何もしませんでした。"
    fi
  fi

  if [ "$CMA_DRY_RUN" = "1" ]; then
    if [ "$n_start" != "0" ]; then
      printf '  [dry-run] %s の既存ブロック (%s) を差し替え\n' "$rc" "$id"
    else
      printf '  [dry-run] %s にブロック (%s) を追記\n' "$rc" "$id"
    fi
    return 0
  fi

  if [ ! -f "$rc" ]; then
    mkdir -p "$(dirname "$rc")" || cma_die "ディレクトリ作成に失敗: $(dirname "$rc")"
    : > "$rc" || cma_die "作成に失敗: $rc"
  fi

  # symlink（dotfiles 管理）なら実体を書き換える。symlink 自体を実ファイルで置き換えない
  local real
  real="$(cma_realpath "$rc")"
  if [ "$real" != "$rc" ]; then
    cma_info "$rc は symlink です。実体を更新します: $real"
    rc="$real"
  fi

  # 変更前にバックアップ（壊した時に戻せるように・既存バックアップは上書きしない）
  local backup
  backup="$(cma_backup_path "$rc")"
  cp -p "$rc" "$backup" || cma_die "バックアップに失敗: $backup"

  # 元のパーミッションを引き継ぐ（mv でファイルを置き換えるため）
  local mode
  mode="$(/usr/bin/stat -f '%Lp' "$rc" 2>/dev/null || echo 644)"

  local tmp="${rc}.cma.$$"
  awk -v s="$start" -v e="$end" '
    $0 == s { skip = 1 }
    skip == 0 { print }
    $0 == e { skip = 0 }
  ' "$rc" > "$tmp" || { rm -f "$tmp"; cma_die "$rc の加工に失敗しました"; }

  printf '\n%s\n' "$content" >> "$tmp" || { rm -f "$tmp"; cma_die "$rc への追記に失敗しました"; }
  chmod "$mode" "$tmp" 2>/dev/null || true
  mv "$tmp" "$rc" || { rm -f "$tmp"; cma_die "$rc の更新に失敗しました"; }
  printf '  ✅ %s を更新（ブロック: %s / バックアップ: %s）\n' "$rc" "$id" "$backup"
}

# symlink を張る。既に同じ向きなら何もしない。実体ファイル/ディレクトリは絶対に壊さない。
#   cma_link <src> <dst>
cma_link() {
  local src="$1" dst="$2"
  [ -e "$src" ] || return 0            # 共有元が無いものはスキップ（環境差を吸収）
  if [ -L "$dst" ]; then
    local cur
    cur="$(readlink "$dst")"
    if [ "$cur" = "$src" ]; then
      cma_info "既存 symlink: $(basename "$dst") → そのまま"
      return 0
    fi
    if [ "$CMA_DRY_RUN" = "1" ]; then
      printf '  [dry-run] symlink 張り替え: %s (%s → %s)\n' "$dst" "$cur" "$src"
      return 0
    fi
    rm "$dst" || cma_die "既存 symlink の削除に失敗: $dst"
  elif [ -e "$dst" ]; then
    cma_warn "実体が既にあるため symlink を作りません: ${dst}（手動で確認してください）"
    return 0
  fi
  if [ "$CMA_DRY_RUN" = "1" ]; then
    printf '  [dry-run] symlink: %s → %s\n' "$dst" "$src"
    return 0
  fi
  ln -s "$src" "$dst" || cma_die "symlink 作成に失敗: $dst"
  printf '  ✅ symlink: %s → %s\n' "$(basename "$dst")" "$src"
}

# 共有対象の既定セット（メイン ~/.claude から借りるもの）。
# ここに session / projects / history / .claude.json を **絶対に入れない**。
# それらを分けることがアカウント分離の本体。
CMA_SHARE_DEFAULT="CLAUDE.md settings.json settings.local.json skills agents commands hooks plugins scripts output-styles statusline-command.sh"

# 共有してはいけないもの（誤設定の検出用）
cma_is_forbidden_share() {
  case "$1" in
    .claude.json|sessions|projects|history.jsonl|.credentials.json|.oauth-token|todos|shell-snapshots) return 0 ;;
    *) return 1 ;;
  esac
}
