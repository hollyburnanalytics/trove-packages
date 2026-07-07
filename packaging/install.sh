#!/bin/sh
# trove installer — downloads the prebuilt single binary for this OS/arch and
# installs it to ~/.local/bin (no root, no Node, no toolchain).
#
#   curl -fsSL https://ontrove.sh/install.sh | sh
#
# Override the version with TROVE_VERSION, the install dir with TROVE_INSTALL_DIR.
set -eu

REPO="hollyburnanalytics/trove-packages"
INSTALL_DIR="${TROVE_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${TROVE_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || err "missing required tool: $1"; }

need uname
need tar
if command -v curl >/dev/null 2>&1; then dl() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then dl() { wget -qO "$2" "$1"; }
else err "need curl or wget"; fi

# Map uname → release asset target.
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) case "$arch" in
      arm64|aarch64) target="darwin-arm64" ;;
      x86_64) target="darwin-x64" ;;
      *) err "unsupported macOS arch: $arch" ;; esac ;;
  Linux) case "$arch" in
      x86_64) target="linux-x64" ;;
      aarch64|arm64) target="linux-arm64" ;;
      *) err "unsupported Linux arch: $arch" ;; esac ;;
  *) err "unsupported OS: $os (Windows: use install.ps1). ARM Windows: 'bunx @ontrove/cli')" ;;
esac

asset="trove-${target}.tar.gz"
if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading trove ($target, $VERSION)…"
dl "$base/$asset" "$tmp/$asset" || err "download failed: $base/$asset"

# Verify the checksum (fail closed). Requires SHA256SUMS on the release and a
# sha256 tool — sha256sum on Linux, shasum on macOS.
dl "$base/SHA256SUMS" "$tmp/SHA256SUMS" || err "could not download SHA256SUMS to verify the download"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  err "no sha256 tool found (need 'sha256sum' or 'shasum') — cannot verify the download"
fi
# SHA256SUMS lines look like '<hash>  ./<asset>' or '<hash>  <asset>'; match the
# basename either way.
expected="$(grep -E "[ /]${asset}\$" "$tmp/SHA256SUMS" | awk '{print $1}' | head -n1)"
[ -n "$expected" ] || err "no checksum listed for $asset in SHA256SUMS"
actual="$(sha256 "$tmp/$asset")"
[ "$expected" = "$actual" ] || err "checksum verification failed for $asset (expected $expected, got $actual)"
say "Checksum OK."

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$INSTALL_DIR"
mv "$tmp/trove-${target}" "$INSTALL_DIR/trove"
chmod +x "$INSTALL_DIR/trove"
say "Installed trove to $INSTALL_DIR/trove"

# --- PATH wiring (rustup pattern): a small env file + a source line in the shell
# rc files, so future shells pick it up. The current shell needs a restart.
env_file="$INSTALL_DIR/env"
cat > "$env_file" <<EOF
case ":\${PATH}:" in
  *:"$INSTALL_DIR":*) ;;
  *) export PATH="$INSTALL_DIR:\$PATH" ;;
esac
EOF

add_source_line() {
  f="$1"; line=". \"$env_file\""
  [ -f "$f" ] || return 0
  grep -qF "$line" "$f" 2>/dev/null || printf '\n%s\n' "$line" >> "$f"
}
add_source_line "$HOME/.profile"
add_source_line "$HOME/.bashrc"
add_source_line "$HOME/.zshrc"
[ -n "${ZDOTDIR:-}" ] && add_source_line "$ZDOTDIR/.zshrc"

case ":${PATH}:" in
  *:"$INSTALL_DIR":*) say "trove is ready. Run: trove --version" ;;
  *) say "Added $INSTALL_DIR to PATH. Restart your shell or run: . \"$env_file\"" ;;
esac
