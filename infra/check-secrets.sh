#!/usr/bin/env bash
# Scans the working tree AND the whole Git history for things that look like secrets.
# Run before every push:   bash infra/check-secrets.sh      (expect: "No secrets found")
cd "$(dirname "$0")/.." || exit 1
PATTERN='(AKIA[0-9A-Z]{16}|postgres(ql)?://[^ "]+:[^ "@]+@|-----BEGIN [A-Z ]*PRIVATE KEY|"jwtSecret" *: *"[0-9a-f]{32,}|JWT_SECRET=[^ ]{8,}|DATABASE_URL=postgres|ghp_[A-Za-z0-9]{30,}|sk_live_[A-Za-z0-9]+)'
FOUND=0

echo "1) files that would be committed"
if git rev-parse --git-dir > /dev/null 2>&1; then
  FILES=$(git ls-files; git ls-files --others --exclude-standard)
else
  FILES=$(find . -type f -not -path './node_modules/*' -not -path '*/node_modules/*' -not -path './.git/*' -not -path './out/*' -not -name '*.png')
fi
for f in $FILES; do
  case "$f" in *.png|*.jpg|*.zip|*check-secrets.sh) continue ;; esac
  if grep -EnH "$PATTERN" "$f" 2>/dev/null; then FOUND=1; fi
done
for f in $FILES; do
  case "$f" in .env|*/.env) echo "   .env file is tracked: $f"; FOUND=1 ;; esac
done

if git rev-parse --git-dir > /dev/null 2>&1; then
  echo "2) the whole Git history"
  if git log -p --all | grep -E "$PATTERN" | grep -v 'check-secrets.sh'; then FOUND=1; fi
fi

if [ $FOUND -eq 0 ]; then echo "No secrets found"; else echo "POSSIBLE SECRETS FOUND - remove them before pushing"; exit 1; fi
