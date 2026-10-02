#!/bin/bash
# اجرای همه‌ی تست‌ها
set -e

cd "$(dirname "$0")/../.."   # ← برگرد به root پروژه

echo "═══════════════════════════════════════"
echo "  OptionHunter Test Suite"
echo "═══════════════════════════════════════"

# 1. Syntax check همه JS
echo ""
echo "── 1) Syntax Check ──"
FAILED_SYNTAX=0
while IFS= read -r file; do
    if ! node --check "$file" 2>/dev/null; then
        echo "❌ syntax error: $file"
        FAILED_SYNTAX=1
    fi
done < <(find backend -name "*.js" -not -path "*/node_modules/*" -not -path "*/tests/*")

if [ $FAILED_SYNTAX -eq 0 ]; then
    echo "✅ all JS files valid"
else
    echo "❌ syntax errors found"
    exit 1
fi

# 2. Python syntax
echo ""
echo "── 2) Python Syntax ──"
if [ -d collector ]; then
    PY_FAILED=0
    while IFS= read -r file; do
        if ! python3 -m py_compile "$file" 2>/dev/null; then
            echo "❌ syntax error: $file"
            PY_FAILED=1
        fi
    done < <(find collector -name "*.py" -not -path "*/venv/*")
    if [ $PY_FAILED -eq 0 ]; then
        echo "✅ all Python files valid"
    else
        exit 1
    fi
fi

# 3. Smoke test
echo ""
echo "── 3) Smoke Test ──"
node backend/tests/smoke.test.js

# 4. API test (اختیاری — نیاز به backend فعال)
echo ""
echo "── 4) API Test ──"
if curl -sf http://127.0.0.1:3000/ping > /dev/null 2>&1; then
    TOKEN=$(grep '^ADMIN_TOKEN=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || echo "")
    ADMIN_TOKEN="$TOKEN" node backend/tests/api.test.js
else
    echo "⚠️ backend آفلاین — skip"
fi

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ All tests passed"
echo "═══════════════════════════════════════"