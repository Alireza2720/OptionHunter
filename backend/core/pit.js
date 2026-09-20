'use strict';
// ============================================================
// pit.js — Point-In-Time Enforcer
// ============================================================
// - PITContext: فیلتر زمانی بر اساس asOfTime
// - checkTrainTestOverlap: تشخیص leakage بین train/test
// ============================================================

class PITContext {
    constructor(asOfTime, options = {}) {
        if (!asOfTime) {
            throw new Error('PITContext requires asOfTime');
        }
        this.asOfTime = asOfTime instanceof Date ? asOfTime : new Date(asOfTime);
        if (isNaN(this.asOfTime.getTime())) {
            throw new Error('PITContext: invalid asOfTime');
        }
        this.purpose = options.purpose || 'unknown'; // 'train' | 'test' | 'live'
        this.boundaries = options.boundaries || null; // [from, to]
        this.violations = [];
        this.strict = options.strict !== false;
    }

    toUnix() {
        return Math.floor(this.asOfTime.getTime() / 1000);
    }

    allows(time) {
        if (time === null || time === undefined) return true;
        let t;
        if (time instanceof Date) t = Math.floor(time.getTime() / 1000);
        else if (typeof time === 'number') t = time;
        else {
            const d = new Date(time);
            if (isNaN(d.getTime())) return true;
            t = Math.floor(d.getTime() / 1000);
        }
        return t <= this.toUnix();
    }

    check(doc, label = 'doc') {
        const time = doc.time || doc.timestamp || doc.createdAt;
        if (!this.allows(time)) {
            this.violations.push({ label, time, asOf: this.asOfTime });
            return false;
        }
        return true;
    }

    filter(docs, label = 'docs') {
        return docs.filter(d => {
            const time = d.time || d.timestamp || d.createdAt;
            if (!this.allows(time)) {
                this.violations.push({ label, time, asOf: this.asOfTime });
                return false;
            }
            return true;
        });
    }

    report() {
        return {
            asOfTime: this.asOfTime,
            purpose: this.purpose,
            boundaries: this.boundaries,
            violations: this.violations.length,
            sample: this.violations.slice(0, 5),
        };
    }
}

// ------------------------------------------------------------
// Train/Test overlap detection
// ------------------------------------------------------------
// range: [from, to] هر دو unix timestamp یا null (null = unbounded)
function checkTrainTestOverlap(trainRange, testRange) {
    if (!trainRange || !testRange) {
        return {
            overlap: true,
            severity: 'warning',
            message: 'محدوده نامشخص',
        };
    }

    const [trainFrom, trainTo] = trainRange;
    const [testFrom, testTo] = testRange;

    // train روی همه دیتا
    if (trainFrom === null && trainTo === null) {
        if (testFrom === null && testTo === null) {
            return {
                overlap: true,
                severity: 'critical',
                message: 'auto-config روی کل دیتا train شده، بک‌تست هم روی کل دیتا → overfit قطعی',
            };
        }
        return {
            overlap: true,
            severity: 'critical',
            message: 'auto-config روی کل دیتا train شده → هر بک‌تستی روی زیرمجموعه‌اش overfit داره',
        };
    }

    // test کاملاً قبل از train
    if (testTo !== null && trainFrom !== null && testTo < trainFrom) {
        return {
            overlap: false,
            severity: 'ok',
            message: 'test قبل از train (clean)',
        };
    }

    // test کاملاً بعد از train (walk-forward استاندارد)
    if (testFrom !== null && trainTo !== null && testFrom > trainTo) {
        return {
            overlap: false,
            severity: 'ok',
            message: 'test بعد از train (walk-forward درست)',
        };
    }

    // overlap
    return {
        overlap: true,
        severity: 'critical',
        message: 'test با train همپوشانی داره → آمار بک‌تست معتبر نیست',
    };
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function rangeFromPayload(payload) {
    // استخراج بازه از payload بک‌تست یا auto-config
    const from = payload.dateFrom || payload.from || null;
    const to = payload.dateTo || payload.to || null;
    return [from ? parseInt(from) : null, to ? parseInt(to) : null];
}

module.exports = {
    PITContext,
    checkTrainTestOverlap,
    rangeFromPayload,
};