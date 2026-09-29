"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Native = require("../plugin/content/opencode-acp.js");

test("OpenCode version checks distinguish unsupported stable versions from unknown output", () => {
  for (const version of ["1.18.30", "1.18.31", "1.19.0"]) assert.equal(Native.parseVersion(version), version);
  assert.equal(Native.parseVersion("opencode 1.18.30\n"), "1.18.30");
  assert.throws(() => Native.parseVersion("1.18.29"), { code: "OPENCODE_VERSION_UNSUPPORTED" });
  assert.throws(() => Native.parseVersion("2.0.0"), { code: "OPENCODE_VERSION_UNSUPPORTED" });
  for (const value of ["1.18.30-dev", "permission denied", ""]) {
    assert.throws(() => Native.parseVersion(value), { code: "OPENCODE_VERSION_UNKNOWN" });
  }
});

test("native launch works without Node or npx and pins private local networking and offline npm", () => {
  const options = Native.launchOptions({ executablePath: "/local/Open Code", cwd: "/paper/session", password: "random-secret", dbPath: "/tmp/probe/db", inheritedPath: "/custom/bin:/usr/bin" });
  assert.equal(options.command, "/local/Open Code");
  assert.deepEqual(options.arguments, ["acp", "--cwd", "/paper/session", "--hostname", "127.0.0.1", "--port", "0", "--mdns=false"]);
  assert.equal(options.workdir, "/paper/session");
  assert.equal(options.environment.OPENCODE_SERVER_PASSWORD, "random-secret");
  assert.equal(options.environment.OPENCODE_DB, "/tmp/probe/db");
  assert.equal(options.environment.npm_config_offline, "true");
  assert.equal(options.environment.OPENCODE_DISABLE_MODELS_FETCH, "1");
  assert.equal(options.environment.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(options.environment.OPENCODE_DISABLE_TERMINAL_TITLE, "1");
  assert.equal(options.arguments.includes("random-secret"), false);
  assert.equal(options.arguments.includes("npx"), false);
  assert.throws(() => Native.launchOptions({ executablePath: "opencode" }), { code: "ACP_PATH_INVALID" });
});

test("Windows OpenCode uses native drive and UNC paths without a shell", () => {
  const previous = global.Zotero;
  global.Zotero = { isWin: true };
  try {
  const options = Native.launchOptions({ executablePath: "C:/Program Files/OpenCode/opencode.exe",
    cwd: "C:/Papers/Session One", dbPath: "C:/Temp/probe.sqlite", nodePath: "C:/Node/node.exe",
    inheritedPath: "C:/Windows/System32;D:/Tools;/foreign" });
  assert.equal(options.command, "C:\\Program Files\\OpenCode\\opencode.exe");
  assert.equal(options.workdir, "C:\\Papers\\Session One");
  assert.equal(options.environment.OPENCODE_DB, "C:\\Temp\\probe.sqlite");
  assert.equal(options.environment.PATH, "C:\\Node;C:\\Program Files\\OpenCode;C:\\Windows\\System32;D:\\Tools");
  assert.deepEqual(options.arguments.slice(0, 3), ["acp", "--cwd", "C:\\Papers\\Session One"]);
  const model = Native.modelLaunchOptions({ executablePath: "C:/Program Files/OpenCode/opencode.exe", cwd: "C:/Temp" }, "unused-marker");
  assert.equal(model.command, options.command);
  assert.deepEqual(model.arguments, ["models", "--verbose"]);
  assert.equal(model.environment.ENV, undefined);
  assert.equal(Native.launchOptions({ executablePath: "\\\\server\\share\\opencode.exe", cwd: "\\\\server\\share\\paper" }).workdir,
    "\\\\server\\share\\paper");
  for (const path of ["C:opencode.exe", "/usr/bin/opencode", "\\opencode.exe", "relative.exe", "C:/bad\0path.exe", "C:/script.cmd"]) {
    assert.throws(() => Native.launchOptions({ executablePath: path }), { code: "ACP_PATH_INVALID" });
  }
  }
  finally { global.Zotero = previous; }
});

test("Windows OpenCode probe reads bounded model data and cleans its own temporary directory", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const launches = [], made = [], removed = [];
  let serial = 0;
  const modelOutput = "provider/model\n" + JSON.stringify({ providerID: "provider", id: "model",
    capabilities: { input: { image: true, pdf: false } }, headers: { Authorization: "secret" } }) + "\n";
  const context = vm.createContext({ TextEncoder, setTimeout, clearTimeout,
    Zotero: { isWin: true },
    Services: { appinfo: { OS: "WINNT" }, uuid: { generateUUID: () => String(++serial) },
      env: { get: () => "C:/Windows/System32" }, dirsvc: { get: () => ({ path: "C:\\Temp" }) } },
    Ci: { nsIFile: {} }, PathUtils: { join: path.win32.join },
    IOUtils: { async makeDirectory(value) { made.push(value); }, async remove(value) { removed.push(value); } },
    ChromeUtils: { importESModule: () => ({ Subprocess: { async call(options) {
      launches.push(options);
      const output = options.arguments[0] === "--version" ? "1.18.32\n" :
        options.arguments[0] === "models" ? modelOutput : "";
      let read = false;
      return { stdin: { close: async () => {} }, kill: async () => {}, wait: async () => ({ exitCode: 0 }),
        stdout: { readString: async () => read ? "" : (read = true, output) }, stderr: { readString: async () => "" } };
    } } }) }
  });
  vm.runInContext(fs.readFileSync(require.resolve("../plugin/content/opencode-acp.js"), "utf8"), context);
  const runtime = context.SmartPaperTranslatorModules.OpenCodeACP.createRuntime({ probe: true,
    readPaths: () => ({ opencodePath: "C:/Program Files/OpenCode/opencode.exe" }) });
  assert.equal(await runtime.readVersion(), "1.18.32");
  const catalog = await runtime.readModelCatalog();
  assert.equal(catalog["provider/model"].image, true);
  assert.equal(JSON.stringify(catalog).includes("secret"), false);
  await runtime.spawn({});
  assert.ok(launches.every(item => item.command === "C:\\Program Files\\OpenCode\\opencode.exe"));
  assert.ok(launches.every(item => !item.arguments.includes("/bin/sh")));
  assert.equal(launches[2].workdir, made[0]);
  await runtime.cleanup();
  assert.deepEqual(removed, made);
});

test("Windows direct model collection closes stdin, preserves exit codes and terminates a real .exe", {
  timeout: 10000, skip: process.platform !== "win32"
}, async () => {
  const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
  const { spawn } = require("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spt opencode win "));
  const launch = source => {
    const options = Native.launchOptions({ executablePath: process.execPath, cwd: root,
      inheritedPath: process.env.PATH || "" }, ["-e", source]);
    assert.equal(options.command, process.execPath);
    const child = spawn(options.command, options.arguments, { cwd: options.workdir,
      env: { ...process.env, ...options.environment }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve({ exitCode: code }));
    });
    child.stdin.on("error", () => {});
    const stdout = child.stdout[Symbol.asyncIterator](), stderr = child.stderr[Symbol.asyncIterator]();
    const pipe = iterator => ({ async readString() {
      const next = await iterator.next();
      return next.done ? "" : next.value.toString("utf8");
    } });
    const processHandle = {
      stdin: { close: async () => { child.stdin.end(); } },
      stdout: pipe(stdout), stderr: pipe(stderr), wait: () => exited,
      kill: async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); return exited; }
    };
    return { child, processHandle, exited };
  };
  let running;
  try {
    running = launch('process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("model output"); });');
    const startupTimers = { setTimeout: callback => setTimeout(callback, 3000), clearTimeout };
    assert.equal(await Native.collect(running.processHandle, 65536, startupTimers), "model output");
    assert.equal((await running.exited).exitCode, 0);

    running = launch('process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("model output"); process.exitCode = 17; });');
    await assert.rejects(Native.collect(running.processHandle, 65536, startupTimers), error =>
      error.code === "OPENCODE_PROCESS_FAILED" && error.message.includes("17") && !error.message.includes("model output"));
    assert.equal((await running.exited).exitCode, 17);

    running = launch('process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("ready"); setInterval(() => {}, 1000); });');
    const timers = { setTimeout: callback => setTimeout(callback, 500), clearTimeout };
    await assert.rejects(Native.collect(running.processHandle, Native.MAX_MODEL_BYTES, timers), { code: "OPENCODE_TIMEOUT" });
    await running.exited;
    assert.equal(running.child.killed, true);
  }
  finally {
    if (running?.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill();
      await running.exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows direct model collection requests cleanup for a stalled process", async () => {
  let closed = 0, killed = 0;
  const blocked = new Promise(() => {});
  const process = { wait: () => blocked, stdout: { readString: () => blocked }, stderr: { readString: () => blocked },
    stdin: { close: async () => { closed++; } }, kill: async () => { killed++; } };
  const timers = { setTimeout: callback => setTimeout(callback, 0), clearTimeout };
  await assert.rejects(Native.collect(process, Native.MAX_MODEL_BYTES, timers), { code: "OPENCODE_TIMEOUT" });
  assert.equal(closed, 1);
  assert.equal(killed, 1);
});

test("OpenCode title controls are filtered across every chunk boundary without changing JSON strings", () => {
  const message = JSON.stringify({ result: { name: "中文模型", text: "\x1b]0;quoted\x07" } });
  const wire = "\x1b]0;paper: ready\x07" + message + "\n\x1b]2;paper: busy\x1b\\";
  for (let split = 0; split <= wire.length; split++) {
    const filter = new Native.TerminalTitleFilter();
    assert.equal(filter.push(wire.slice(0, split)) + filter.push(wire.slice(split)), message + "\n");
    filter.finish();
  }
  const filter = new Native.TerminalTitleFilter();
  assert.equal([...wire].map(char => filter.push(char)).join(""), message + "\n");
  filter.finish();
});

test("OpenCode filtering rejects unknown, oversized and incomplete controls and preserves arbitrary logs", () => {
  for (const text of ["\x1b]52;clipboard\x07", "\x1b[31m", "\x1b]0;bad\nline\x07", "\x1b]0;" + "x".repeat(4096)]) {
    assert.throws(() => new Native.TerminalTitleFilter().push(text), { code: "OPENCODE_STDOUT_CONTROL" });
  }
  const filter = new Native.TerminalTitleFilter();
  assert.equal(filter.push("not JSON\n{broken}\n"), "not JSON\n{broken}\n");
  filter.push("\x1b]0;unfinished");
  assert.throws(() => filter.finish(), { code: "OPENCODE_STDOUT_CONTROL" });
});

test("model command keeps user paths in argv and releases its pipe only after complete bounded output", async () => {
  const executablePath = "/local/a ' $() `command`/opencode";
  const options = Native.modelLaunchOptions({ executablePath, cwd: "/tmp/probe" }, "private-marker");
  assert.equal(options.command, "/bin/sh");
  assert.equal(options.arguments[1].includes(executablePath), false);
  assert.deepEqual(options.arguments.slice(3), ["private-marker", executablePath, "models", "--verbose"]);
  assert.equal(options.environment.ENV, null);
  assert.equal(options.environment.BASH_ENV, null);
  let release, closed = false;
  const data = JSON.stringify({ text: "中文".repeat(40000) });
  const chunks = ["\x1b]0;models: ready\x07", data.slice(0, 32000), data.slice(32000), "\x1b]2;done\x1b", "\\\nprivate-", "marker\n"];
  const process = {
    stdout: { readString: async () => chunks.shift() || "" },
    stderr: { readString: async () => "" },
    stdin: { close: async () => { closed = true; release({ exitCode: 0 }); } },
    wait: () => new Promise(resolve => { release = resolve; }), kill: async () => {}
  };
  assert.equal(await Native.collect(process, Native.MAX_MODEL_BYTES, global, "private-marker"), data);
  assert.equal(closed, true);
  process.stdout = { readString: async () => "" };
  await assert.rejects(Native.collect(process, 100, global, "private-marker"), { code: "OPENCODE_OUTPUT_INCOMPLETE" });
});

test("native model collector preserves exit status and reaps its child on cancellation", { timeout: 5000, skip: process.platform === "win32" }, async () => {
  const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
  const { spawn } = require("node:child_process");
  const { once } = require("node:events");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spt-collector-test-"));
  const executablePath = path.join(root, "opencode ' $literal");
  const launch = () => {
    const options = Native.modelLaunchOptions({ executablePath, cwd: root }, "test-marker");
    return spawn(options.command, options.arguments, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  };
  let child;
  try {
    await fs.writeFile(executablePath, '#!/bin/sh\nprintf "fixture payload"\nexit 17\n', { mode: 0o700 });
    child = launch();
    const exited = once(child, "exit");
    let text = "";
    for await (const chunk of child.stdout) {
      text += chunk.toString();
      if (text.endsWith("\ntest-marker\n")) { child.stdin.end(); break; }
    }
    assert.equal(text, "fixture payload\ntest-marker\n");
    assert.equal((await exited)[0], 17);
    await fs.writeFile(executablePath, '#!/bin/sh\nprintf "%s\\n" "$$"\nexec /bin/sleep 30\n');
    child = launch();
    const stopped = once(child, "exit");
    const [chunk] = await once(child.stdout, "data");
    const ownedPID = Number(chunk.toString().trim());
    assert.ok(Number.isInteger(ownedPID) && ownedPID > 1);
    child.kill("SIGTERM");
    assert.equal((await stopped)[0], 143);
    assert.throws(() => process.kill(ownedPID, 0), { code: "ESRCH" });
  }
  finally {
    child?.kill("SIGTERM");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("model metadata parsing retains only IDs and explicit input capabilities", () => {
  const model = { providerID: "provider", id: "family/model", capabilities: { input: { image: true, pdf: false } }, headers: { Authorization: "secret" }, options: { apiKey: "secret", escaped: 'brace } and "quote' } };
  const text = "provider/family/model\n" + JSON.stringify(model, null, 2) + "\n";
  const catalog = Native.parseModelCatalog(text);
  assert.deepEqual(catalog["provider/family/model"], { image: true, pdf: false });
  assert.equal(JSON.stringify(catalog).includes("secret"), false);
  assert.throws(() => Native.parseModelCatalog(text + text), { code: "OPENCODE_MODEL_FORMAT" });
  assert.throws(() => Native.parseModelCatalog(text.slice(0, -4)), { code: "OPENCODE_MODEL_FORMAT" });
  assert.throws(() => Native.parseModelCatalog(text.replace("provider/family/model", "other/model")), { code: "OPENCODE_MODEL_FORMAT" });
  assert.throws(() => Native.parseModelCatalog("a".repeat(Native.MAX_MODEL_BYTES + 1)), { code: "OPENCODE_MODEL_LIMIT" });
});

test("native probe output is bounded and failures do not expose model stdout", async () => {
  let killed = 0;
  const pipe = text => ({ async readString() { const result = text; text = ""; return result; } });
  const process = { stdout: pipe("secret model metadata"), stderr: pipe(""), wait: async () => ({ exitCode: 1 }), kill: async () => { killed++; } };
  await assert.rejects(Native.collect(process), error => error.code === "OPENCODE_PROCESS_FAILED" && !error.message.includes("secret model"));
  process.stdout = pipe("abc"); process.stderr = pipe(""); process.wait = async () => ({ exitCode: 0 });
  await assert.rejects(Native.collect(process, 2), { code: "OPENCODE_OUTPUT_LIMIT" });
  assert.equal(killed, 2);
});

test("probe runtimes clean only owned temporary data and serialize cleanup before a new connection", async () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const folders = new Set(), removed = [], launches = [];
  let counter = 0, finishKill;
  const context = vm.createContext({ TextEncoder, setTimeout, clearTimeout,
    Services: { uuid: { generateUUID: () => String(++counter) }, env: { get: () => "" }, dirsvc: { get: () => ({ path: "/tmp" }) } },
    Ci: { nsIFile: {} }, PathUtils: { join: (...parts) => parts.join("/") },
    IOUtils: { async makeDirectory(path, options) { assert.equal(options.permissions, 0o700); folders.add(path); }, async remove(path) { removed.push(path); folders.delete(path); } },
    ChromeUtils: { importESModule: () => ({ Subprocess: { async call(options) {
      launches.push(options);
      return { stdin: { close: async () => {} }, kill: async () => { if (launches.length === 1) await new Promise(resolve => { finishKill = resolve; }); } };
    } } }) }
  });
  vm.runInContext(fs.readFileSync(require.resolve("../plugin/content/opencode-acp.js"), "utf8"), context);
  const make = probe => context.SmartPaperTranslatorModules.OpenCodeACP.createRuntime({ readPaths: () => ({ opencodePath: "/local/opencode" }), probe });
  const probe = make(true);
  await probe.spawn({});
  const original = launches[0];
  const stopping = probe.cleanup();
  const restart = probe.spawn({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches.length, 1);
  finishKill(); await stopping; await restart;
  assert.notEqual(launches[1].workdir, original.workdir);
  assert.notEqual(launches[1].environment.OPENCODE_SERVER_PASSWORD, original.environment.OPENCODE_SERVER_PASSWORD);
  assert.deepEqual(removed, [original.workdir]);
  await probe.cleanup();
  const paper = make(false);
  await paper.spawn({ cwd: "/paper/persistent-workspace" });
  assert.equal(launches.at(-1).environment.OPENCODE_DB, undefined);
  await paper.cleanup();
  assert.equal(removed.includes("/paper/persistent-workspace"), false);
  assert.equal(folders.size, 0);
});
