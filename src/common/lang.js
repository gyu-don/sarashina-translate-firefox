// 背景ページ・コンテンツスクリプト・ポップアップで共有する言語判定ユーティリティ。
// import/export を持たないので、classic script としても ES module としても読み込める。
(function (global) {
  "use strict";

  // ひらがな・カタカナ・CJK統合漢字・半角カナ
  const JA_RE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/g;
  const LATIN_RE = /[A-Za-z]/g;

  function count(re, text) {
    const m = text.match(re);
    return m ? m.length : 0;
  }

  /** テキストの主言語を推定する。判定できなければ null。 */
  function detect(text) {
    const ja = count(JA_RE, text);
    const latin = count(LATIN_RE, text);
    if (ja === 0 && latin === 0) return null;
    // 日本語は1文字あたりの情報量が多いので重みを付ける
    return ja * 3 >= latin ? "ja" : "en";
  }

  /** target 言語へ翻訳する価値があるか（= 反対側の言語で書かれているか）。 */
  function needsTranslation(text, target) {
    if (target === "ja") {
      if (count(LATIN_RE, text) < 2) return false;
      return detect(text) === "en";
    }
    if (count(JA_RE, text) < 1) return false;
    return detect(text) === "ja";
  }

  function opposite(lang) {
    return lang === "ja" ? "en" : "ja";
  }

  global.SarashinaLang = { detect, needsTranslation, opposite };
})(globalThis);
