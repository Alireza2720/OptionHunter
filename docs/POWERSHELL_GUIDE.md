# راهنمای اسکریپت‌نویسی PowerShell برای OptionHunter

> نسخه ۱ — بر اساس درس‌های Stage 1 تا Deep-fix

---

## 1. قوانین طلایی

1. از exit در top-level استفاده نکن — پنجره PowerShell بسته می‌شود.
2. از کاراکترهای { و } داخل مقدار رشته‌ای hashtable استفاده نکن — parser می‌شکند.
3. منطق پیچیده را در Node.js بنویس، نه PowerShell.
4. نتیجه verify را در فایل status (مثل _sN-status.txt) ذخیره کن.
5. قبل از هر تغییر backup با پسوند bNNN-stamp بگیر.
6. روی همه فایل‌های JS دستور node --check بزن.
7. روی اسکریپت اصلی index.html از new Function(mainScript) استفاده کن.
8. CRLF-safe و BOM-safe باش.
9. از do { ... } while ($false) برای کنترل جریان استفاده کن.
10. پیام خطا را قبل از rollback در فایل status ذخیره کن.

## 2. Anti-pattern ها

### exit در top-level

بد:

    if (-not (Test-Path $f)) { exit 1 }

خوب:

    $abortReason = ""
    do { if (-not (Test-Path $f)) { $abortReason = "missing"; break } } while ($false)
    if ($abortReason) { Write-Host "ABORT: $abortReason" }

### { یا } در مقدار رشته‌ای hashtable

بد:

    $checks = @( @{P="if (x) { y; }"; NEED=1} )

خوب: کل منطق verify را به Node منتقل کن.

### verify با Select-String روی آرایه

مشکل: در paste interactive، scope متغیر persist نمی‌شود.
خوب: در Node از split(p).length - 1 استفاده کن.

## 3. Template استاندارد

1. Backup با bNNN-stamp
2. Node fixer → _sN-status.txt
3. PowerShell status را می‌خواند
4. اگر FAIL → rollback و ABORT
5. اگر OK → node --check روی فایل‌های بک‌اند
6. اگر syntax-fail → rollback و ABORT
7. git add + commit + push
8. Sleep 90s (auto-deploy)
9. SSH verify
10. Print VERIFY-BEGIN/END
11. Read-Host آخر

## 4. الگوی Node fixer

    const fs = require("fs");
    const path = require("path");
    const statusFile = path.join(process.cwd(), "_sN-status.txt");
    function done(msg) { try { fs.writeFileSync(statusFile, msg, "utf8"); } catch (_) {} process.exit(0); }

    function readBOM(p) { let t = fs.readFileSync(p, "utf8"); const b = t.charCodeAt(0) === 0xFEFF; return { txt: b ? t.slice(1) : t, bom: b }; }
    function writeBOM(p, t, b) { fs.writeFileSync(p, (b ? "\uFEFF" : "") + t, "utf8"); }

    function find(txt, pat) {
        let i = txt.indexOf(pat); if (i >= 0) return { i, l: pat.length };
        const lf = pat.replace(/\r?\n/g, "\n"); i = txt.indexOf(lf); if (i >= 0) return { i, l: lf.length };
        const crlf = pat.replace(/\r?\n/g, "\r\n"); i = txt.indexOf(crlf); if (i >= 0) return { i, l: crlf.length };
        return null;
    }

    function patch(txt, desc, oldPat, newPat) {
        const m = find(txt, oldPat);
        if (!m) throw new Error("NOT_FOUND:" + desc);
        return txt.slice(0, m.i) + newPat + txt.slice(m.i + m.l);
    }

چرا slice و نه String.replace: چون replace الگوهای $&, $1, $' را در رشته newPat تفسیر می‌کند و ممکن است رشته را خراب کند. slice امن است.

## 5. الگوی verify برای index.html

    try {
        const re = /<script>([\s\S]*?)<\/script>/g;
        let m, mainScript = null;
        while ((m = re.exec(txt)) !== null) {
            if (m[1].indexOf("const BACKEND_URL") !== -1) { mainScript = m[1]; break; }
        }
        if (!mainScript) throw new Error("main script not found");
        new Function(mainScript);
    } catch (e) { throw new Error("JS_SYNTAX:" + e.message); }

    const n1 = txt.split("marker1").length - 1;
    if (n1 < 1) throw new Error("post:marker1=" + n1);

## 6. دستورهای آماده

### خواندن توکن ادمین روی سرور

    ssh deploy@185.239.0.243 "TOKEN=$(grep ^ADMIN_TOKEN= ~/apps/OptionHunter/.env | cut -d= -f2); curl -s -H "x-admin-token: $TOKEN" http://127.0.0.1:3000/api/..."

### git log روی سرور

    ssh deploy@185.239.0.243 "cd ~/apps/OptionHunter && git log --oneline -1"

## 7. Check-list قبل از ارسال اسکریپت

- [ ] هیچ exit در top-level نیست
- [ ] هیچ { یا } در مقدار رشته‌ای hashtable نیست
- [ ] همه patch ها در Node هستند
- [ ] backup قبل از patch
- [ ] node --check روی همه فایل‌های JS
- [ ] new Function روی اسکریپت index.html
- [ ] verify به شکل فایل _sN-status.txt
- [ ] do { ... } while ($false) برای جریان
- [ ] VERIFY-BEGIN/END در انتها
- [ ] Read-Host آخر

## 8. Encoding

- اسکریپت‌های PowerShell: UTF-8 با BOM
- فایل‌های JS و HTML پروژه: UTF-8 با BOM
- _sN-status.txt: UTF-8 بدون BOM
- docs/*.md: UTF-8 بدون BOM

---

نسخه ۱ — 1405/07/22