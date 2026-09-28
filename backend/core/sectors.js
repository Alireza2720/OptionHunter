'use strict';
// ============================================================
// sectors.js — نقشه‌برداری نماد → صنعت (تأییدشده)
// ============================================================

const DEFAULT_SECTORS = {
    'اهرم': 'صندوق اهرمی', 'موج': 'صندوق اهرمی', 'توان': 'صندوق اهرمی',
    'دارونو': 'صندوق دارویی', 'طعام': 'صندوق غذایی',
    'اطلس': 'صندوق سهامی', 'جوانه کوچک': 'صندوق سهامی', 'کاریس': 'صندوق سهامی',
    'سینرژی': 'صندوق کالایی',
    'وتجارت': 'بانک', 'وبصادر': 'بانک', 'وبملت': 'بانک',
    'خودرو': 'خودرو', 'خبهمن': 'خودرو', 'خساپا': 'خودرو',
    'هم تراز': 'دارو', 'دزاگرس': 'دارو', 'بساما': 'بیمه',
    'شپنا': 'پالایش',
    'فملی': 'فلزات اساسی', 'ذوب': 'فولاد', 'فزر': 'معدن طلا',
    'شستا': 'هلدینگ', 'تاصیکو': 'هلدینگ',
    'اخابر': 'مخابرات', 'فرابورس': 'خدمات مالی'
};

// 🆕 نگاشت معکوس: صنعت → نمادها
function getSectorPeers(symbol) {
    const sec = getSector(symbol);
    const peers = [];
    for (const [sym, s] of Object.entries(DEFAULT_SECTORS)) {
        if (s === sec && sym !== symbol) peers.push(sym);
    }
    return peers;
}

// 🆕 لیست همه‌ی صنایع
function getAllSectors() {
    return [...new Set(Object.values(DEFAULT_SECTORS))];
}

function getSector(symbol) {
    return DEFAULT_SECTORS[symbol] || 'سایر';
}

function getSectorMap(symbols) {
    const out = {};
    for (const s of symbols) out[s] = getSector(s);
    return out;
}

module.exports = { DEFAULT_SECTORS, getSector, getSectorMap, getSectorPeers, getAllSectors };