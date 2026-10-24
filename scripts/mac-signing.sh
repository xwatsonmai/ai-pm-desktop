#!/bin/zsh
# Signs the packaged app with the user's Apple certificate when there is one.
#
# The keychain remembers "Always Allow" per Team ID. An app without one (ad-hoc
# or self-signed) is remembered by its code hash, which changes with every
# build, so each update asks for the keychain again. An "Apple Development"
# certificate from a free Apple ID in Xcode (Settings › Accounts › Manage
# Certificates) carries a Team ID and ends that.
#
#   scripts/mac-signing.sh sign <app>
set -euo pipefail

app="${2:?用法：scripts/mac-signing.sh sign <app>}"
[ "${1:-}" = sign ] || { sed -n '2,10p' "$0"; exit 1; }

line=$(security find-identity -v -p codesigning 2>/dev/null | grep -E '"(Developer ID Application|Apple Development): ' | head -1 || true)
if [ -n "$line" ]; then
  hash=$(echo "$line" | awk '{ print $2 }')
  name=$(echo "$line" | sed -E 's/^[^"]*"(.*)"$/\1/')
  codesign --force --deep --sign "$hash" "$app"
  echo "已用 $name 签名"
else
  echo "警告：没有找到 Apple Development 证书，这次用临时签名；钥匙串授权在每次更新后会重新询问。在 Xcode › 设置 › 帐户里用 Apple ID 创建一张 Apple Development 证书即可解决。" >&2
  codesign --force --deep --sign - "$app"
fi
