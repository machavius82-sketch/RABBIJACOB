// Génère index.html : page autonome qui exécute RegistreCrypto.jsx avec React et Recharts (UMD, jsDelivr).
// Usage : npm run build            → index.html
//         node build.mjs --fragment out.html   → contenu sans <html>/<head>/<body> (hébergement d'artifact)
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const CDN = [
  "https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js",
  "https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js",
  "https://cdn.jsdelivr.net/npm/prop-types@15.8.1/prop-types.min.js",
  "https://cdn.jsdelivr.net/npm/recharts@2.15.4/umd/Recharts.js",
];

const GLOBALS = { react: "React", "react-dom/client": "ReactDOM", recharts: "Recharts" };

const globalsPlugin = {
  name: "umd-globals",
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom\/client|recharts)$/ }, (args) => ({ path: args.path, namespace: "umd-global" }));
    b.onLoad({ filter: /.*/, namespace: "umd-global" }, (args) => ({
      contents: `module.exports = window.${GLOBALS[args.path]};`,
      loader: "js",
    }));
  },
};

const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import RegistreCrypto from "./RegistreCrypto.jsx";
createRoot(document.getElementById("root")).render(React.createElement(RegistreCrypto));
`;

const result = await build({
  stdin: { contents: entry, resolveDir: here, loader: "jsx", sourcefile: "main.jsx" },
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2019",
  charset: "utf8",
  legalComments: "none",
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  plugins: [globalsPlugin],
  write: false,
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const title = "Registre Crypto";
const head = `<title>${title}</title>
<meta name="description" content="Suivi personnel de portefeuille crypto : transactions, plus-values, marché, watchlist et alertes de prix.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Public+Sans:wght@400;500;600;700&display=swap">
<style>
  :root { --page: #F3F5F8; --page-ink: #3E4A59; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --page: #0E131A; --page-ink: #B4BFCC; color-scheme: dark; } }
  :root[data-theme="dark"] { --page: #0E131A; --page-ink: #B4BFCC; color-scheme: dark; }
  html, body { margin: 0; background: var(--page); }
  .boot { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--page-ink); padding: 32px 16px; max-width: 60ch; }
</style>`;

const body = `<div id="root"><p class="boot">Chargement de Registre Crypto…</p></div>
${CDN.map((src) => `<script src="${src}"></script>`).join("\n")}
<script>
if (window.React && window.ReactDOM && window.Recharts) {
${js}
} else {
  document.getElementById("root").innerHTML = '<p class="boot">Impossible de charger React ou Recharts depuis le CDN jsDelivr. Vérifiez la connexion Internet puis rechargez la page.</p>';
}
</script>`;

const fragmentIdx = process.argv.indexOf("--fragment");
if (fragmentIdx > -1) {
  const out = process.argv[fragmentIdx + 1];
  if (!out) throw new Error("--fragment attend un chemin de sortie");
  await writeFile(out, `${head}\n${body}\n`, "utf8");
  console.log(`Fragment écrit : ${out} (${Math.round(js.length / 1024)} Ko de JS)`);
} else {
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head}
</head>
<body>
${body}
</body>
</html>
`;
  await writeFile(join(here, "index.html"), html, "utf8");
  console.log(`index.html écrit (${Math.round(js.length / 1024)} Ko de JS)`);
}
