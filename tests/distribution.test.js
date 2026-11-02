"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

test("Windows Git checkout preserves the exact bytes of bundled JavaScript runtimes", t => {
  const repository = path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "spt-checkout-"));
  t.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  fs.copyFileSync(path.join(repository, ".gitattributes"), path.join(temporary, ".gitattributes"));
  const attributes = path.join(temporary, "empty-global-attributes");
  fs.writeFileSync(attributes, "");
  const files = ["d3/d3.min.js", "katex/katex.min.js", "mermaid/mermaid.min.js"]
    .map(name => "plugin/content/vendor/" + name);
  const originals = new Map();
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(repository, name));
    originals.set(name, bytes);
    const destination = path.join(temporary, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=true", "-c", "core.eol=crlf",
    "-c", "core.attributesFile=" + attributes, ...args], { cwd: temporary, stdio: "pipe" });
  git("init", "--quiet");
  git("add", ".gitattributes", ...files);
  for (const name of files) fs.unlinkSync(path.join(temporary, name));
  git("checkout-index", "--all");
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  for (const name of files) {
    assert.equal(digest(fs.readFileSync(path.join(temporary, name))), digest(originals.get(name)),
      name + " changed during Windows checkout");
  }
});
