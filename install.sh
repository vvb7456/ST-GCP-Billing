#!/usr/bin/env bash
# 用法: ./install.sh /path/to/SillyTavern
# 复制服务端插件到 plugins/agent-platform-billing，前端扩展到 public/scripts/extensions/third-party/agent-platform-billing。
# 已有的 plugins/agent-platform-billing/data（账本与定价设置）会保留。
set -euo pipefail

ST_DIR="${1:?请传入 SillyTavern 根目录}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -f "$ST_DIR/server.js" ] || { echo "不是 SillyTavern 目录: $ST_DIR" >&2; exit 1; }

PLUGIN_DST="$ST_DIR/plugins/agent-platform-billing"
EXT_DST="$ST_DIR/public/scripts/extensions/third-party/agent-platform-billing"

mkdir -p "$PLUGIN_DST" "$EXT_DST"
cp "$SRC_DIR"/server/*.mjs "$PLUGIN_DST/"
cp "$SRC_DIR"/extension/* "$EXT_DST/"

if grep -Eq '^enableServerPlugins:\s*true' "$ST_DIR/config.yaml" 2>/dev/null; then
    echo "config.yaml 已启用 enableServerPlugins"
else
    echo "注意：请在 $ST_DIR/config.yaml 中设置 enableServerPlugins: true"
fi
echo "安装完成，重启 SillyTavern 后生效。"

