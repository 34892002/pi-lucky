/**
 * i18n gate for the desktop renderer.
 *
 * Ports pi-gui's `tests/unit/i18n.spec.ts` and `tests/unit/renderer-copy.spec.ts` to a
 * plain Bun script, because pi-lucky has no test runner: `bun run i18n:verify`.
 *
 * Two jobs:
 *
 * 1. The catalogs are well formed — English defines the key set, every other locale
 *    only refines it, placeholders survive translation, and the fallback / plural /
 *    system-language rules still behave.
 * 2. Translated surfaces cannot bypass the catalogs. Any user-facing literal left in
 *    the JSX of a surface listed in `TRANSLATED_SURFACES` fails the run, which is what
 *    keeps a finished surface from drifting back to English one line at a time.
 *
 * `bun run i18n:check` is the other half: it reports copy still missing (never fails).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import {
  LOCALES,
  appLocaleIds,
  defaultLocale,
  languageTagParts,
  localeDefinition,
  matchSystemLocale,
  textDirectionFor,
  type AppLocale,
  type MessageKey,
  type Messages,
} from "../src/i18n/catalog";
import { localePreferences, resolveLocale, type LocalePreference } from "../src/i18n/preference";
import { catalogs, interpolate, resolveMessage, translatorFor } from "../src/i18n/translate";
import { en } from "../src/i18n/messages/en";
import { zhCN } from "../src/i18n/messages/zh-CN";

/** True when the text sits inside a <kbd>, where the platform key name is not copy. */
function insideKbd(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    ts.isJsxElement(parent) &&
    ts.isIdentifier(parent.openingElement.tagName) &&
    parent.openingElement.tagName.text === "kbd"
  );
}


const failures: string[] = [];
const checks: string[] = [];

function check(name: string, run: () => void): void {
  try {
    run();
    checks.push(name);
  } catch (error) {
    failures.push(`${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

function equal<T>(actual: T, expected: T, reason: string): void {
  if (actual !== expected) {
    throw new Error(`${reason}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function equalList<T>(actual: readonly T[], expected: readonly T[], reason: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${reason}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const englishKeys = new Set(Object.keys(en));
const pluralCategory = /_(zero|one|two|few|many|other)$/;
/** Keys English gives plural forms to; other locales may add any CLDR category for them. */
const pluralBaseKeys = new Set(
  [...englishKeys]
    .filter((key) => pluralCategory.test(key))
    .map((key) => key.replace(pluralCategory, "")),
);

function isEnglishKeyOrPluralForm(key: string): boolean {
  return englishKeys.has(key) || pluralBaseKeys.has(key.replace(pluralCategory, ""));
}

function placeholders(template: string): readonly string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

/** zh-CN with `keys` removed, as a catalog looks before a translator catches up. */
function zhCNWithout(...keys: readonly MessageKey[]): Partial<Messages> {
  const catalog: Partial<Record<MessageKey, string>> = { ...zhCN };
  for (const key of keys) delete catalog[key];
  return catalog;
}

check("the locale registry is well formed and covers its own preferences", () => {
  equal(LOCALES[0].id, defaultLocale, "the first entry is the fallback locale");
  equalList(
    [...new Set(LOCALES.map((locale) => locale.id))],
    appLocaleIds,
    "locale ids are unique",
  );
  equalList(
    [...localePreferences],
    ["system", ...appLocaleIds],
    '"system" is the only preference that is not a locale',
  );
  for (const locale of LOCALES) {
    const reason = `locale ${locale.id}`;
    if (!locale.label.trim()) throw new Error(`${reason} label is empty`);
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale.id)) {
      throw new Error(`${reason} id is not a language tag`);
    }
    equal(localeDefinition(locale.id).id, locale.id, reason);
    equal(textDirectionFor(locale.id), locale.dir ?? "ltr", reason);
  }
});

check("other locales define only English keys, with non-empty copy and the same placeholders", () => {
  for (const locale of LOCALES) {
    for (const [key, copy] of Object.entries(catalogs[locale.id])) {
      const reason = `locale ${locale.id} ${key}`;
      if (!isEnglishKeyOrPluralForm(key)) throw new Error(`${reason} is not an English key`);
      if (!copy?.trim()) throw new Error(`${reason} is empty`);
      const source = en[key as MessageKey] ?? en[key.replace(pluralCategory, "") as MessageKey];
      equalList(placeholders(copy), placeholders(source), reason);
    }
  }
});

check("a key that is not translated yet renders the English copy", () => {
  const zh = translatorFor("zh-CN");
  equal(zh("settings.nav.general"), "通用", "zh-CN translation");
  if (zh("settings.nav.general") === en["settings.nav.general"]) {
    throw new Error("zh-CN copy still reads English");
  }
  const behind = translatorFor("zh-CN", zhCNWithout("settings.nav.general"));
  equal(behind("settings.nav.general"), "General", "missing key falls back to English");
  equal(behind("settings.nav.appearance"), zh("settings.nav.appearance"), "translated key survives");
  equal(
    translatorFor("zh-CN", {})("secondarySurface.sectionsLabel", { title: "设置" }),
    "设置 sections",
    "placeholders still fill in on the English fallback",
  );
  equal(resolveMessage({}, "totally.unknown" as MessageKey), "totally.unknown", "unknown key");
});

check("interpolate substitutes known names and leaves unknown ones alone", () => {
  equal(interpolate("Search {title}", { title: "settings" }), "Search settings", "known name");
  equal(interpolate("{a} {b}", { a: 1 }), "1 {b}", "unknown name is kept");
  equal(interpolate("no placeholders"), "no placeholders", "template without placeholders");
});

check("a counted message picks the CLDR plural form of the active locale", () => {
  const english = translatorFor("en");
  equal(english("models.count", { count: 1 }), "1 model", "en one");
  equal(english("models.count", { count: 0 }), "0 models", "en other");
  equal(english("models.count", { count: 4 }), "4 models", "en other");
  const chinese = translatorFor("zh-CN");
  for (const count of [0, 1, 4]) {
    equal(chinese("models.count", { count }), `${count} 个模型`, `zh-CN ${count}`);
  }
  const behind = translatorFor("zh-CN", zhCNWithout("models.count"));
  equal(behind("models.count", { count: 1 }), "1 model", "English plurals when zh-CN is behind");
  equal(behind("models.count", { count: 2 }), "2 models", "English plurals when zh-CN is behind");
  const polish: Partial<Messages> = {
    "models.count_one": "{count} model",
    "models.count_few": "{count} modele",
    "models.count_many": "{count} modeli",
  };
  equal(new Intl.PluralRules("pl").select(2), "few", "CLDR category for Polish 2");
  equal(isEnglishKeyOrPluralForm("models.count_few"), true, "extra CLDR category is allowed");
  equal(isEnglishKeyOrPluralForm("settings.nav.models_few"), false, "other keys cannot gain one");
  equal(
    Object.keys(polish).every(isEnglishKeyOrPluralForm),
    true,
    "a locale may define the categories it needs",
  );
  equal(english("settings.nav.models", { count: 3 }), "Models", "count on a plain message");
});

check("the language follows the OS until the user picks one", () => {
  const cases: readonly (readonly [LocalePreference, readonly string[], AppLocale])[] = [
    ["system", ["zh-CN", "en-US"], "zh-CN"],
    ["system", ["zh-Hans-CN"], "zh-CN"],
    ["system", ["en-US", "zh-CN"], "en"],
    ["system", ["de-DE", "zh-TW"], "zh-CN"],
    ["system", [], "en"],
    // "xx" is reserved for no linguistic content, so a new language never invalidates this.
    ["system", ["xx-XX"], "en"],
    ["en", ["zh-CN"], "en"],
    ["zh-CN", ["en-US"], "zh-CN"],
  ];
  for (const [preference, systemLanguages, expected] of cases) {
    equalList(systemLanguages, systemLanguages, "case");
    equal(
      resolveLocale(preference, systemLanguages),
      expected,
      `${preference} ${JSON.stringify(systemLanguages)}`,
    );
  }
});

check("language tags split into primary, script and region subtags", () => {
  equalList(
    [languageTagParts("zh-Hant-TW")],
    [{ primary: "zh", script: "hant", region: "tw" }],
    "tag parts",
  );
  equal(languageTagParts("zh-CN").region, "cn", "region");
  equal(languageTagParts("EN-us").primary, "en", "primary is case-folded");
  equal(matchSystemLocale("ZH-hant"), "zh-CN", "script is case-folded");
  equal(matchSystemLocale("  en-GB  "), "en", "tag is trimmed");
  equal(matchSystemLocale("de-DE"), undefined, "unregistered language");
  equal(matchSystemLocale(""), undefined, "empty tag");
});

/** Executable examples and format names, not untranslated prose. */
const technicalCopy = new Set([
  "URL",
  "API",
  "OAuth",
  "docs",
  "npx",
  "ollama-local",
  "model-id",
  "http://localhost:11434/v1",
  "http://localhost:8000/v1",
  "https://example.com/mcp",
  "-y @modelcontextprotocol/server-filesystem .",
  "--api-key",
  "/v1",
  "~/.pi/agent/models.json",
  "/bin/zsh",
]);
const copyAttributes = new Set([
  "title",
  "description",
  "label",
  "aria-label",
  "placeholder",
  "textareaPlaceholder",
  "textareaLabel",
  "body",
  "backLabel",
]);

const sourceRoot = path.resolve(import.meta.dir, "../src");

/**
 * Surfaces that are fully translated. A directory entry covers every `.tsx` in it, so a
 * new Settings section is checked without anyone remembering to list it here.
 */
const TRANSLATED_SURFACES = [
  "app",
  "features/command-palette",
  "features/conversation",
  "features/extensions",
  "features/scheduled-tasks",
  "features/settings",
  "features/threads",
  "features/workbench",
];

async function surfaceFiles(): Promise<readonly string[]> {
  const files: string[] = [];
  for (const surface of TRANSLATED_SURFACES) {
    const entries = await readdir(path.resolve(sourceRoot, surface), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/.tsx?$/.test(entry.name)) continue;
      const parent = entry.parentPath.slice(sourceRoot.length + 1).split(path.sep).join("/");
      files.push(`${parent}/${entry.name}`);
    }
  }
  return files;
}

async function findUntranslatedCopy(): Promise<readonly string[]> {
  const untranslated: string[] = [];
  for (const file of await surfaceFiles()) {
    const source = await readFile(path.resolve(sourceRoot, file), "utf8");
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const report = (node: ts.Node, text: string) => {
      const copy = text.replace(/\s+/g, " ").trim();
      if (!/[A-Za-z]{2}/.test(copy) || technicalCopy.has(copy)) return;
      // Class names, platform ids, data-* values, `true`/`false`, `currentColor`.
      if (/^[-a-z][a-z0-9_.:/\-]*$/.test(copy)) return;
      if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(copy)) return;
      if (copy.includes("__") || copy.includes("--")) return;
    // Data URIs and other inline payloads are code, not copy.
    if (copy.startsWith("data:") || copy.includes(";base64,")) return;
    // Glyph entities such as &#x25BC; carry no language.
    if (/^(&#x?[0-9a-fA-F]+;)+$/.test(copy)) return;
      // A catalog key handed through an object literal, e.g. `body: "app.recovery.failed.body"`.
      if (/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/.test(copy)) return;
      untranslated.push(
        `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ${copy}`,
      );
    };
    const expression = (node: ts.Expression) => {
      if (ts.isStringLiteralLike(node)) report(node, node.text);
      else if (ts.isTemplateExpression(node)) {
        report(node, node.head.text + node.templateSpans.map((span) => span.literal.text).join(" "));
      } else if (ts.isConditionalExpression(node)) {
        expression(node.whenTrue);
        expression(node.whenFalse);
      } else if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      ) {
        expression(node.right);
      }
    };
    const walk = (node: ts.Node) => {
      // Key caps (<kbd>Esc</kbd>) are keyboard labels, not copy.
      if (ts.isJsxText(node) && !insideKbd(node)) report(node, node.text);
      // {cond ? "A" : "B"}, {label ?? "fallback"}, {flag && "note"}
      if (ts.isJsxExpression(node) && node.expression) expression(node.expression);
      // `{ title: "New thread" }` in a command/action table, not just a JSX attribute.
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        copyAttributes.has(node.name.text)
      ) {
        expression(node.initializer);
      }
      if (ts.isJsxAttribute(node) && copyAttributes.has(node.name.getText(tree)) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text);
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          expression(node.initializer.expression);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
  }
  return untranslated;
}

const files = await surfaceFiles();
if (!files.includes("features/settings/settings-view.tsx")) {
  failures.push(
    `translated surfaces: expected features/settings/settings-view.tsx in ${JSON.stringify(files)}`,
  );
} else {
  const untranslated = await findUntranslatedCopy();
  if (untranslated.length > 0) {
    failures.push(
      `translated surfaces cannot bypass the locale catalogs; add technical examples to ` +
        `technicalCopy in this script:\n    ${untranslated.join("\n    ")}`,
    );
  } else {
    checks.push(`translated surfaces (${files.length} files) use the catalogs`);
  }
}

console.log(
  JSON.stringify(
    {
      locales: LOCALES.map((locale) => locale.id),
      englishKeys: englishKeys.size,
      catalogKeys: Object.fromEntries(
        LOCALES.map((locale) => [locale.id, Object.keys(catalogs[locale.id]).length]),
      ),
      translatedSurfaces: files,
      checks,
      failures,
    },
    null,
    1,
  ),
);

if (failures.length > 0) {
  console.error(`\ni18n: ${failures.length} failure(s)`);
  process.exitCode = 1;
}
