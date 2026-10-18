#!/usr/bin/env bash
#
# dev.sh - 扩展的开发调试入口。
#
# 子命令：
#   install   把仓库里的文件装到用户扩展目录（并重新编译 schema）
#   reload    重启 gnome-shell 让新代码生效（X11 有效；Wayland 必须重新登录）
#   status    扩展是否启用、是否 ERROR、关键设置的值
#   diag      一键采集诊断，写到 .workbuddy/logs/ 下（共享文件夹里宿主可直接读）
#   log       跟踪 journal 里本扩展的输出
#
# 为什么要有这个脚本：GNOME Shell 扩展的失败几乎是静默的——扩展停在
# enabled 但什么都不做，界面看起来和没装一样。诊断必须能回答三件事：
# 代码有没有加载、加载的是哪一份、它自己认为发生了什么。

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UUID=appindicatorsupport@rgcjonas.gmail.com
SCHEMA_ID=org.gnome.shell.extensions.appindicator
SCHEMA_DIR=schemas
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
LOG_DIR="$ROOT/.workbuddy/logs"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*"; }

session_type() {
    printf '%s' "${XDG_SESSION_TYPE:-unknown}"
}

# 一份代码里读到的设置键（直接读的 + 监听变化的），每行一个，已排序去重。
keys_read_by() {
    local dir="$1"

    {
        (cd "$dir" && grep -ohE \
            "\.(get|set)_(boolean|string|strv|int|double|value|enum)\('[a-z0-9-]+'" \
            ./*.js ./preferences/*.js 2>/dev/null |
            sed -E "s/.*'([a-z0-9-]+)'/\1/")
        grep -ohE 'changed::[a-z0-9-]+' "$dir"/*.js 2>/dev/null |
            sed 's/changed:://'
    } | sort -u
}

# 报出 $2 有、$3 没有的键。
report_missing() {
    local what="$1" left="$2" right="$3" missing

    missing=$(comm -23 "$left" "$right")

    if [ -n "$missing" ]; then
        warn "$what 用到的键，已安装的 schema 里没有（静默失效的典型原因）："
        printf '%s\n' "$missing" | sed 's/^/     /'
    else
        note "$what: 不缺键"
    fi
}

# ---------------------------------------------------------------- install
cmd_install() {
    say "安装到用户扩展目录"
    note "源码: $ROOT"
    note "目标: $DEST"

    if [ -d "$DEST" ] && [ ! -w "$DEST" ]; then
        warn "$DEST 不可写（以前用 sudo 装过）。先修一次属主："
        note "sudo chown -R \$USER:\$USER \"$DEST\""
        return 1
    fi

    install -d "$DEST" "$DEST/schemas" || return 1

    # meson 打包时就是按 git ls-files 收 JS 的，这里保持一致，免得装出来的
    # 副本和 make install 的结果不一样。
    local files count=0
    files=$(git -C "$ROOT" -c safe.directory="$ROOT" ls-files -- '*.js' metadata.json 2>/dev/null)

    if [ -z "$files" ]; then
        note "没有 git（或不是仓库），退回 find"
        files=$(cd "$ROOT" && find . -name '*.js' -not -path './_build*' \
            -not -path './.git/*' -printf '%P\n' 2>/dev/null)
    fi

    while IFS= read -r f; do
        [ -n "$f" ] && [ -f "$ROOT/$f" ] || continue
        install -D -m 644 "$ROOT/$f" "$DEST/$f" && count=$((count + 1))
    done <<< "$files"
    note "复制 $count 个文件"

    cp -f "$ROOT"/$SCHEMA_DIR/*.xml "$DEST/schemas/" 2>/dev/null
    if glib-compile-schemas "$DEST/schemas"; then
        note "schema 编译 OK"
    else
        warn "schema 编译失败"
        return 1
    fi

    [ -d "$ROOT/icons" ] && cp -rf "$ROOT/icons" "$DEST/"
    gnome-extensions enable "$UUID" 2>&1 | sed 's/^/   /'
    note "下一步：dev.sh reload"
}

# ---------------------------------------------------------------- reload
cmd_reload() {
    local type
    type=$(session_type)

    case "$type" in
    x11)
        say "重启 gnome-shell（X11）"
        killall -HUP gnome-shell && sleep 3
        note "已发送 SIGHUP"
        ;;
    wayland)
        warn "Wayland 会话下扩展代码只在登录时加载，SIGHUP 会结束会话。"
        note "请注销后重新登录，再跑 dev.sh status"
        ;;
    *)
        warn "会话类型未知（$type），不自动重启"
        ;;
    esac
}

# ---------------------------------------------------------------- status
cmd_status() {
    say "扩展"
    gnome-extensions info "$UUID" 2>&1 | sed 's/^/   /'
    note "--- 运行状态（state: 1=ENABLED, 2=DISABLED, 3=ERROR）"
    gdbus call --session --dest org.gnome.Shell.Extensions \
        --object-path /org/gnome/Shell/Extensions \
        --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" 2>&1 |
        tr ',' '\n' | grep -E "'state'|'error'" | sed 's/^/   /'

    say "同一份托盘功能的另一个扩展"
    for other in ubuntu-appindicators@ubuntu.com; do
        if gnome-extensions list 2>/dev/null | grep -qx "$other"; then
            note "$other:"
            gnome-extensions info "$other" 2>/dev/null | head -6 | sed 's/^/     /'
            note "两个都开 → 图标由谁画取决于加载顺序，排查时先关掉它："
            note "  gnome-extensions disable $other"
        fi
    done

    say "关键设置（读的是已安装副本自带的 schema）"
    local schema_dir="$DEST/schemas"
    [ -d "$schema_dir" ] || schema_dir="$ROOT/$SCHEMA_DIR"
    for key in tray-pos hidden-icons known-icons language-area-role \
        panel-background-mode panel-background-color panel-background-opacity; do
        printf '   %-26s %s\n' "$key" \
            "$(gsettings --schemadir "$schema_dir" get "$SCHEMA_ID" "$key" 2>&1 | head -1)"
    done
}

# ---------------------------------------------------------------- diag
# 诊断落盘的位置。共享目录（vboxsf / 9p 挂载的仓库）在虚拟机里宿主能直接读，
# 这正是「拿不到 guest 控制权也能取现场」的那条通道，所以优先用它。
# 只有它不可写时才退回本机状态目录。告警走 stderr，避免被 $(...) 当成路径。
log_path() {
    local dir="$LOG_DIR"

    if ! mkdir -p "$dir" 2>/dev/null || [ ! -w "$dir" ]; then
        dir="${XDG_STATE_HOME:-$HOME/.local/state}/appindicator-logs"
        mkdir -p "$dir"
        warn "共享目录不可写，日志落在 $dir" >&2
    fi

    printf '%s/diag-%s.txt' "$dir" "$(date +%Y%m%d-%H%M%S)"
}

cmd_diag() {
    local out="${LOG_OUT:-$(log_path)}"

    say "环境"
    printf '   时间        %s\n' "$(date -Iseconds)"
    printf '   主机        %s\n' "$(uname -n)"
    printf '   系统        %s\n' "$(. /etc/os-release && echo "$PRETTY_NAME")"
    printf '   内核        %s\n' "$(uname -r)"
    printf '   会话        %s\n' "$(session_type)"
    printf '   GNOME       %s\n' "$(gnome-shell --version 2>/dev/null | tr -d '\n')"
    printf '   源码        %s\n' "$ROOT"
    printf '   安装副本    %s\n' "$DEST"

    cmd_status

    say "装了几份"
    for dir in /usr/share/gnome-shell/extensions/"$UUID" \
        /usr/local/share/gnome-shell/extensions/"$UUID" \
        "$HOME/.local/share/gnome-shell/extensions/$UUID"; do
        [ -d "$dir" ] || continue
        printf '   %s\n' "$dir"
        printf '     panelAreas.js  %s\n' \
            "$(date -r "$dir/panelAreas.js" '+%F %T' 2>/dev/null || echo '缺')"
        printf '     gschemas       %s\n' \
            "$(date -r "$dir/schemas/gschemas.compiled" '+%F %T' 2>/dev/null || echo '缺')"
    done

    say "schema 与代码是否对得上"
    local installed="$DEST"
    if [ ! -d "$installed" ]; then
        warn "没有已安装副本，跳过"
    else
        local tmp
        tmp=$(mktemp -d)

        gsettings --schemadir "$installed/schemas" list-keys "$SCHEMA_ID" 2>/dev/null |
            sort > "$tmp/schema-keys"

        keys_read_by "$installed" > "$tmp/installed-keys"
        keys_read_by "$ROOT" > "$tmp/repo-keys"
        grep -oE '<key name="[^"]+"' "$ROOT"/$SCHEMA_DIR/*.xml 2>/dev/null |
            sed -E 's/.*"(.*)"/\1/' | sort -u > "$tmp/xml-keys"

        note "键数：已安装 schema $(wc -l < "$tmp/schema-keys")｜已安装代码 $(wc -l < "$tmp/installed-keys")｜仓库代码 $(wc -l < "$tmp/repo-keys")｜仓库 XML $(wc -l < "$tmp/xml-keys")"

        # 两个方向都要看：装的代码比 schema 新（复制了 js 没编 schema），
        # 以及仓库的 XML 比装上那份编译结果新（同一个坑的另一半）。
        report_missing "已安装的代码" "$tmp/installed-keys" "$tmp/schema-keys"
        report_missing "仓库里的代码" "$tmp/repo-keys" "$tmp/schema-keys"
        report_missing "仓库的 schema XML" "$tmp/xml-keys" "$tmp/schema-keys"
    fi

    say "日志（本次启动，最近 60 行）"
    journalctl --user -b -o cat 2>/dev/null |
        grep -iE "appindicator|JS ERROR|not a constructor|out of date, it has no" |
        tail -60 | sed 's/^/   /' || note "无"

    say "怎么打开 debug 级日志"
    note "状态行和拖拽决策都是 debug 级，默认不打印（日志域是 "
    note "appindicator-support，由 metadata.json 的 name 派生）。"
    note "要打开：写一个会话环境文件，注销重登后生效——"
    note "  echo 'G_MESSAGES_DEBUG=appindicator-support' \\"
    note "    > ~/.config/environment.d/90-appindicator-debug.conf"
    note "日常排查先看上面三条 warn 就够了：schema 缺键、隐藏 id 失配、"
    note "PanelAreas 缺失。"

    printf '\n\033[1m== 诊断已写入\033[0m\n   %s\n' "$out"
}

# ---------------------------------------------------------------- log
cmd_log() {
    say "跟踪 journal（Ctrl-C 结束）"
    journalctl --user -f -o cat 2>/dev/null |
        grep --line-buffered -iE "appindicator|JS ERROR"
}

case "${1:-help}" in
install) cmd_install ;;
reload) cmd_reload ;;
status) cmd_status ;;
diag)
    # 输出整段交给 tee 同步写盘。原来在 cmd_diag 里 exec > >(tee) 是进程替换，
    # bash 不会等那个 tee 收尾，脚本一快就丢内容——实测日志文件全是 0 字节。
    if [ -z "${DEV_DIAG_TEE:-}" ]; then
        diag_out=$(log_path)
        DEV_DIAG_TEE=1 LOG_OUT="$diag_out" "$0" diag 2>&1 | tee "$diag_out"
        exit "${PIPESTATUS[0]}"
    fi
    cmd_diag
    ;;
log) cmd_log ;;
*)
    sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
esac
