// Resolve theme before paint to avoid flash-of-wrong-theme.
//
// Lives in its own file (rather than inline in index.html) so the
// site can ship a Content-Security-Policy with `script-src 'self'`
// and no 'unsafe-inline' carve-out. A classic <script src> in <head>
// is parser-blocking, so this still runs before first paint exactly
// like the inline version did.
(function () {
  try {
    var stored = localStorage.getItem("gk:theme");
    var sysDark =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme = stored || (sysDark ? "dark" : "dark"); // dark default per spec
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
