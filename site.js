// Las Vegas trip — shared language handling and navigation.
window.Site = (() => {
  const LANG_KEY = "vegas-trip-lang";
  const COMMON = {
    en: { toggle: "中文", toggleAria: "切换到中文", navAria: "Pages", navItin: "Itinerary", navFlights: "Flights", navParks: "Parks & sights", navSky: "Sky", navBudget: "Budget", navAsk: "Ask" },
    zh: { toggle: "English", toggleAria: "Switch to English", navAria: "页面", navItin: "行程", navFlights: "机票", navParks: "公园与景点", navSky: "星空", navBudget: "预算", navAsk: "提问" },
  };
  const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  function detect() {
    if (location.hash === "#zh" || location.hash === "#en") { const l = location.hash.slice(1); store.set(LANG_KEY, l); return l; }
    const s = store.get(LANG_KEY); if (s === "zh" || s === "en") return s;
    const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
    return langs.some(l => /^zh\b/i.test(l)) ? "zh" : "en";
  }
  let lang = detect();
  function init(UI, render) {
    const full = () => {
      const t = { ...COMMON[lang], ...UI[lang] };
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
      if (t.docTitle) document.title = t.docTitle;
      document.querySelectorAll("[data-i18n]").forEach(el => { if (t[el.dataset.i18n] != null) el.textContent = t[el.dataset.i18n]; });
      document.querySelectorAll("[data-i18n-html]").forEach(el => { if (t[el.dataset.i18nHtml] != null) el.innerHTML = t[el.dataset.i18nHtml]; });
      document.querySelectorAll("[data-i18n-aria]").forEach(el => { if (t[el.dataset.i18nAria] != null) el.setAttribute("aria-label", t[el.dataset.i18nAria]); });
      document.querySelectorAll("[data-nav]").forEach(a => { a.href = a.dataset.nav + "#" + lang; });
      const tog = document.getElementById("lang-toggle");
      if (tog) { tog.textContent = t.toggle; tog.setAttribute("aria-label", t.toggleAria); }
      render(t, lang);
    };
    const tog = document.getElementById("lang-toggle");
    if (tog) tog.addEventListener("click", () => { lang = lang === "en" ? "zh" : "en"; store.set(LANG_KEY, lang); full(); });
    window.addEventListener("hashchange", () => { if (location.hash === "#zh" || location.hash === "#en") { lang = location.hash.slice(1); full(); } });
    full();
    return { rerender: full, get lang() { return lang; } };
  }
  return { init, esc, store, get lang() { return lang; } };
})();
