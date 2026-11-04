#!/usr/bin/env node
// Single-terminal log viewer for mobile-mcp + an Android app under test.
//
//   node scripts/dev-logs.mjs [--package com.mli.mspace] [--device emulator-5554]
//                             [--port 3100] [--compact] [--full] [--headers]
//                             [--all-logcat] [--no-server] [--no-color] [--no-clear]
//                             [--grep <term>] [--log-file out.log]
//
// Responses are shown complete and pretty-printed by default; --compact
// shortens bodies to one line and long tool results to 12 lines.
//
// Keys while running: "/" search (filter + highlight, including earlier
// entries), Esc clear search, "c" clear screen, "?" help, Ctrl+C quit.
//
// It starts `node lib/index.js --listen 127.0.0.1:<port>` and streams two things
// into one readable feed:
//   MCP   every request/response that reaches the mobile-mcp HTTP endpoint
//   APP   logcat of the app process (API request/response blocks, JS logs, errors)

import { spawn, execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface, emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PACKAGE = opt("package", "com.mli.mspace");
const DEVICE = opt("device", "emulator-5554");
const PORT = Number(opt("port", "3100"));
const FULL = flag("full");
const SHOW_HEADERS = flag("headers");
const ALL_LOGCAT = flag("all-logcat");
const NO_SERVER = flag("no-server");
const CLEAR_ON_RESTART = !flag("no-clear");
const INITIAL_GREP = opt("grep", null);
const COLOR = !flag("no-color") && process.stdout.isTTY;
const LOG_FILE = opt("log-file", null);
// Responses are printed complete by default. --compact shortens long bodies
// and long tool results so more entries fit on one screen.
const COMPACT = flag("compact") && !FULL;
const MAX_INLINE = COMPACT ? 320 : Infinity;
const MAX_RESULT_LINES = COMPACT ? 12 : Infinity;

const ADB = process.env.ADB || resolve(process.env.LOCALAPPDATA || "", "Android/Sdk/platform-tools/adb.exe");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- output helpers ----------
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = s => c("2", s);
const bold = s => c("1", s);
const cyan = s => c("36", s);
const green = s => c("32", s);
const yellow = s => c("33", s);
const red = s => c("31", s);
const magenta = s => c("35", s);
const blue = s => c("34", s);

const now = () => new Date().toTimeString().slice(0, 8);
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, "");
const write = s => process.stdout.write(s);

// ---------- records, history and search ----------
// Every printed entry is a "record" (a single line, or a whole MCP/API block).
// Records are kept in memory so a search can be applied to what was already
// printed, not just to new output. Press "/" in the terminal to search.
const MAX_HISTORY = 5000;
const history = [];
let filter = null; // { term, test: RegExp, mark: RegExp }
let typing = null; // text being typed after "/" or null

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matches = record => !filter || filter.test.test(stripAnsi(record));
const highlight = record => (filter ? record.replace(filter.mark, m => c("7", m)) : record);

const out = record => {
	history.push(record);
	if (history.length > MAX_HISTORY) {
		history.shift();
	}

	if (LOG_FILE) {
		appendFileSync(LOG_FILE, stripAnsi(record) + "\n");
	}

	if (typing === null && matches(record)) {
		write(highlight(record) + "\n");
	}
};

const compactJson = value => {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	if (s.length <= MAX_INLINE) {
		return s;
	}

	return s.slice(0, MAX_INLINE) + dim(` ...(+${s.length - MAX_INLINE} chars)`);
};

const prettyOrCompact = value => {
	if (COMPACT) {
		return [compactJson(value)];
	}

	return (typeof value === "string" ? value : JSON.stringify(value, null, 2)).split("\n");
};

const redactHeaders = headers => {
	const copy = { ...headers };
	for (const key of Object.keys(copy)) {
		if (/authorization|api-key|token|cookie/i.test(key)) {
			copy[key] = String(copy[key]).slice(0, 12) + "...(redacted)";
		}
	}

	return copy;
};

const statusColor = status => {
	const n = Number(status);
	if (n >= 500) return red(String(status));
	if (n >= 400) return yellow(String(status));
	return green(String(status));
};

const box = (title, lines, footer) => {
	const block = [title, ...lines.map(l => `${dim("|")}  ${l}`), `${dim("+--")} ${footer ?? ""}`, ""];
	out(block.join("\n"));
};

// ---------- MCP side: parse the request-logger stream ----------
let mcpState = null; // { id, phase: "req"|"res", buf: [], status, ms }
let suppressUntilMarker = false; // true while inside the tool wrapper's multi-line "=> ..." dump
const pending = new Map();

const describeArgs = args => {
	if (!args || typeof args !== "object") return "";
	return Object.entries(args)
		.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
		.join("  ");
};

const summarizeResult = (request, response) => {
	if (response.error) {
		return [red(`error ${response.error.code}: ${response.error.message}`)];
	}

	const result = response.result ?? {};
	if (request.method === "initialize") {
		return [`${result.serverInfo?.name} ${result.serverInfo?.version}  protocol ${result.protocolVersion}`];
	}

	if (request.method === "tools/list") {
		const names = (result.tools ?? []).map(t => t.name);
		return [`${names.length} tools: ${names.join(", ")}`];
	}

	if (request.method === "tools/call") {
		const texts = (result.content ?? []).map(part => (part.type === "text" ? part.text : `<${part.type}>`));
		let lines = texts.join("\n").split("\n");
		if (lines.length > MAX_RESULT_LINES) {
			lines = [...lines.slice(0, MAX_RESULT_LINES), dim(`...(+${lines.length - MAX_RESULT_LINES} more lines)`)];
		}

		return lines.map(l => (result.isError ? red(l) : l));
	}

	return prettyOrCompact(result);
};

const printMcp = (id, request, response, status, ms) => {
	const method = request.method ?? "?";
	const tool = request.params?.name;
	const title = `${dim("+--")} ${bold(cyan("MCP"))} ${dim("#" + id)}  ${dim(now())}  ${bold(method)}${tool ? "  " + magenta(tool) : ""}`;
	const lines = [];
	const args = describeArgs(request.params?.arguments ?? (method === "tools/call" ? {} : request.params));
	if (args) {
		lines.push(`${dim("args   ")} ${args}`);
	}

	for (const l of summarizeResult(request, response)) {
		lines.push(`${dim("result ")} ${l}`);
	}

	box(title, lines, `${statusColor(status)} ${dim("-")} ${ms} ms`);
};

const tryParseBuffer = buf => {
	try {
		return JSON.parse(buf.join("\n"));
	} catch {
		return undefined;
	}
};

const handleMcpLine = raw => {
	const line = raw.replace(/\r$/, "");

	let m = line.match(/^>>> \[#(\d+)\] (\S+) (\S+)$/);
	if (m) {
		mcpState = { id: m[1], phase: "req", buf: [] };
		suppressUntilMarker = false;
		return;
	}

	m = line.match(/^<<< \[#(\d+)\] (\d+) \((\d+) ms\)$/);
	if (m) {
		mcpState = { id: m[1], phase: "res", buf: [], status: m[2], ms: m[3] };
		suppressUntilMarker = false;
		return;
	}

	if (mcpState) {
		if (line === "<empty>") {
			mcpState = null;
			return;
		}

		mcpState.buf.push(line);
		const parsed = line === "}" || line === "]" ? tryParseBuffer(mcpState.buf) : undefined;
		if (parsed !== undefined) {
			if (mcpState.phase === "req") {
				pending.set(mcpState.id, parsed);
			} else {
				const request = pending.get(mcpState.id) ?? {};
				pending.delete(mcpState.id);
				printMcp(mcpState.id, request, parsed, mcpState.status, mcpState.ms);
			}

			mcpState = null;
		}

		return;
	}

	// The tool wrapper's own "Invoking ..." / "=> ..." lines are covered by the block above.
	// A "=> " result can span many lines; swallow them until the next >>> / <<< marker.
	if (/^Invoking \w+ with args:/.test(line)) {
		return;
	}

	if (line.startsWith("=> ")) {
		suppressUntilMarker = true;
		return;
	}

	if (suppressUntilMarker) {
		return;
	}

	if (line.trim()) {
		const tone = /warn|error/i.test(line) ? yellow : dim;
		out(`${bold(cyan("MCP"))}  ${dim(now())}  ${tone(line)}`);
	}
};

// ---------- APP side: logcat ----------
const LOGCAT_RE = /^(\d\d-\d\d \d\d:\d\d:\d\d)\.\d+ ([VDIWEF])\/([^(]+)\( *\d+\): ?(.*)$/;
const RN_RE = /^(\d{1,2}:\d\d:\d\d [AP]M) \| (\w+) : (.*)$/;
const INTERESTING_TAGS = new Set(["ReactNativeJS", "System.err", "AndroidRuntime", "RNFBCrashlyticsInit", "ExpoModulesCore"]);

let apiBlock = null; // message lines collected between API RESPONSE START/END

const parseApiBlock = lines => {
	const fields = {};
	let key = null;
	for (const l of lines) {
		const m = l.match(/^([A-Z]+)\s*:\s?(.*)$/);
		if (m && /^(URL|METHOD|STATUS|DURATION|SCREEN|HEADERS|REQUEST|RESPONSE|ERROR)$/.test(m[1])) {
			key = m[1];
			fields[key] = m[2];
		} else if (key) {
			fields[key] += "\n" + l;
		}
	}

	for (const k of ["HEADERS", "REQUEST", "RESPONSE"]) {
		if (fields[k]) {
			try {
				fields[k] = JSON.parse(fields[k]);
			} catch {
				fields[k] = fields[k].trim();
			}
		}
	}

	return fields;
};

const printApiBlock = lines => {
	const f = parseApiBlock(lines);
	let path = f.URL ?? "";
	let host = "";
	try {
		const u = new URL(f.URL);
		host = u.host;
		path = u.pathname + u.search;
	} catch {
		// not a URL, print as-is
	}

	const status = (f.STATUS ?? "").trim();
	const title = `${dim("+--")} ${bold(blue("APP API"))}  ${dim(now())}  ${bold(f.METHOD ?? "?")} ${path}   ${statusColor(status)} ${dim("-")} ${(f.DURATION ?? "").trim()}${f.SCREEN ? dim("   screen=" + f.SCREEN.trim()) : ""}`;
	const body = [];
	if (SHOW_HEADERS && f.HEADERS) {
		for (const l of prettyOrCompact(typeof f.HEADERS === "object" ? redactHeaders(f.HEADERS) : f.HEADERS)) {
			body.push(`${dim("headers ")} ${l}`);
		}
	}

	if (f.REQUEST !== undefined) {
		for (const l of prettyOrCompact(f.REQUEST)) {
			body.push(`${dim("request ")} ${l}`);
		}
	}

	if (f.RESPONSE !== undefined) {
		for (const l of prettyOrCompact(f.RESPONSE)) {
			body.push(`${dim("response")} ${l}`);
		}
	}

	if (f.ERROR && !/^No Error/i.test(f.ERROR.trim())) {
		body.push(`${dim("error   ")} ${red(f.ERROR.trim())}`);
	}

	box(title, body, dim(host));
};

const levelColor = { V: dim, D: dim, I: s => s, W: yellow, E: red, F: red };

// Emulator / React Native chatter that never helps when reading app logs.
// --all-logcat turns this filter off.
const NOISE = [
	/concurrent (mark compact|copying) GC freed|Background young/,
	/A resource failed to call close/,
	/GFXSTREAM|GLClientState|EGL_emulation|eglCodecCommon/,
	/WrappingUtils|Don't know how to round that drawable/,
	/Draw requested for a non-attached controller|Cleared Reference was only reachable/,
	/ReactHost\{\d+\}\.(onHost|ReactContext)|BridgelessReact/,
	/ViewManagerPropertyUpdater|nativeloader|jni_lib_merge|SoLoader|GraphicsEnvironment|ResourcesManager/,
	/Accessing hidden (method|field)|Unable to open '.*\.dm'|Compiler allocated/,
	/^Looper|Davey!|Skipped \d+ frames/,
];

const isNoise = (tag, msg) => NOISE.some(re => re.test(msg) || re.test(tag));

// Collapse Java stack traces: keep the first few frames, count the rest.
const MAX_FRAMES = FULL ? Infinity : 3;
const MAX_LINE = COMPACT ? 400 : Infinity;
let frameCount = 0;
let framesHidden = 0;

const flushFrames = () => {
	if (framesHidden > 0) {
		out(`${bold(blue("APP"))}  ${dim(now())}  ${dim(`      ...(+${framesHidden} more frames)`)}`);
	}

	frameCount = 0;
	framesHidden = 0;
};

const handleLogcatLine = raw => {
	const line = stripAnsi(raw.replace(/\r$/, ""));
	const m = line.match(LOGCAT_RE);
	if (!m) {
		return;
	}

	const [, , level, tagRaw, msg] = m;
	const tag = tagRaw.trim();

	const isFrame = /^\s*at [\w$.<>]+\(/.test(msg);
	if (isFrame) {
		frameCount++;
		if (frameCount > MAX_FRAMES) {
			framesHidden++;
			return;
		}
	} else if (frameCount > 0) {
		flushFrames();
	}

	if (!ALL_LOGCAT && !FULL && isNoise(tag, msg)) {
		return;
	}

	if (tag === "ReactNativeJS") {
		if (/API RESPONSE START/.test(msg)) {
			apiBlock = [];
			return;
		}

		if (apiBlock) {
			if (/API RESPONSE END/.test(msg)) {
				printApiBlock(apiBlock);
				apiBlock = null;
			} else {
				apiBlock.push(msg);
			}

			return;
		}

		const rn = msg.match(RN_RE);
		if (rn) {
			const [, , lvl, text] = rn;
			const tone = /ERROR/i.test(lvl) ? red : /WARN/i.test(lvl) ? yellow : /DEBUG/i.test(lvl) ? dim : s => s;
			out(`${bold(blue("APP"))}  ${dim(now())}  ${tone(lvl.padEnd(5))}  ${tone(text)}`);
			return;
		}

		if (FULL && msg.trim()) {
			out(`${bold(blue("APP"))}  ${dim(now())}  ${dim("     ")}  ${dim(msg)}`);
		}

		return;
	}

	const important = level === "E" || level === "F" || level === "W";
	if (ALL_LOGCAT || important || INTERESTING_TAGS.has(tag) || tag.includes(PACKAGE)) {
		const tone = levelColor[level] ?? (s => s);
		const text = msg.length > MAX_LINE ? msg.slice(0, MAX_LINE) + dim(` ...(+${msg.length - MAX_LINE} chars)`) : msg;
		out(`${bold(blue("APP"))}  ${dim(now())}  ${tone(level)}/${tone(tag.replace(/^unknown:/, ""))}  ${tone(text)}`);
	}
};

// Anything a child writes to stderr that is not part of the normal streams is
// shown with its origin, so a crash message can never appear without a label.
const tagStderr = (stream, label) => {
	readLines(stream, line => {
		if (line.trim()) {
			out(`${bold(red(label))}  ${dim(now())}  ${red(line)}`);
		}
	});
};

const readLines = (stream, handler) => {
	createInterface({ input: stream, crlfDelay: Infinity }).on("line", handler);
};

// ---------- start server ----------
if (!NO_SERVER) {
	const server = spawn(process.execPath, [resolve(ROOT, "lib/index.js"), "--listen", `127.0.0.1:${PORT}`], {
		cwd: ROOT,
		env: { ...process.env, MOBILEMCP_LOG_REQUESTS: "1" },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	readLines(server.stderr, handleMcpLine);
	readLines(server.stdout, handleMcpLine);
	server.on("exit", code => {
		out(red(`MCP server exited with code ${code}`));
		process.exit(code ?? 1);
	});
	process.on("SIGINT", () => {
		server.kill();
		process.exit(0);
	});
}

// ---------- start logcat, following app restarts ----------
const pidOf = () => {
	try {
		return execFileSync(ADB, ["-s", DEVICE, "shell", "pidof", PACKAGE], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim().split(/\s+/)[0] || null;
	} catch (err) {
		const text = String(err.stderr ?? "").trim();
		if (text && !/not found|no devices|offline/i.test(text)) {
			out(`${bold(red("ADB"))}  ${dim(now())}  ${red(`pidof failed: ${text.split("\n")[0]}`)}`);
		}

		return null;
	}
};

// `logcat --pid` keeps running after the process dies, so poll pidof and
// re-attach whenever the app is restarted (new pid) or appears for the first time.
let currentPid = null;
let logcatProc = null;
let runCount = 0;

const attachLogcat = pid => {
	if (logcatProc) {
		logcatProc.removeAllListeners("exit");
		logcatProc.kill();
	}

	currentPid = pid;
	apiBlock = null;
	out(`${bold(blue("APP"))}  ${dim(now())}  ${dim(`attached to ${PACKAGE} (pid ${pid}) on ${DEVICE}`)}`);
	logcatProc = spawn(ADB, ["-s", DEVICE, "logcat", "-v", "time", "-T", "1", `--pid=${pid}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	readLines(logcatProc.stdout, handleLogcatLine);
	tagStderr(logcatProc.stderr, "ADB LOGCAT");
	logcatProc.on("exit", () => {
		logcatProc = null;
		currentPid = null;
	});
};

const clearScreen = () => {
	if (process.stdout.isTTY) {
		write("\x1b[2J\x1b[3J\x1b[H");
	}
};

const followLogcat = () => {
	const pid = pidOf();
	if (pid && pid !== currentPid) {
		if (runCount > 0) {
			if (CLEAR_ON_RESTART) {
				history.length = 0;
				clearScreen();
				printHeader();
				out(`${bold(blue("APP"))}  ${dim(now())}  ${yellow(`${PACKAGE} run #${runCount + 1} started (pid ${pid}). Terminal cleared.`)}`);
			} else {
				out(`${bold(blue("APP"))}  ${dim(now())}  ${yellow(`${PACKAGE} run #${runCount + 1} started (pid ${pid})`)}`);
			}
		}

		runCount++;
		attachLogcat(pid);
	} else if (!pid && currentPid) {
		out(`${bold(blue("APP"))}  ${dim(now())}  ${yellow(`${PACKAGE} process ended, waiting for it to start again...`)}`);
		if (logcatProc) {
			logcatProc.kill();
		}

		currentPid = null;
	}

	setTimeout(followLogcat, 1500);
};

const printHeader = () => {
	write(bold(`mobile-mcp dev logs  ${dim("-")}  app ${PACKAGE}  ${dim("-")}  device ${DEVICE}  ${dim("-")}  ${NO_SERVER ? "server: external" : `server http://127.0.0.1:${PORT}/mcp`}`) + "\n");
	write(dim("keys:  /  search (filters + highlights, includes earlier logs)   Esc  clear search   c  clear screen   ?  help   Ctrl+C  quit") + "\n");
	write(dim(`responses: ${COMPACT ? "compact (--compact)" : "complete, pretty-printed (use --compact to shorten)"}   noise filter: ${FULL || ALL_LOGCAT ? "off" : "on (--full or --all-logcat to disable)"}`) + "\n");
	if (filter) {
		const count = history.filter(matches).length;
		write(yellow(`filter: "${filter.term}"  -  ${count} of ${history.length} entries match  -  Esc to clear`) + "\n");
	}

	write("\n");
};

// Redraw the screen from history, applying the current filter.
const redraw = () => {
	clearScreen();
	printHeader();
	const visible = history.filter(matches);
	const shown = filter ? visible : visible.slice(-300);
	if (!filter && visible.length > shown.length) {
		write(dim(`...(${visible.length - shown.length} earlier entries not shown, use / to search them)`) + "\n");
	}

	for (const record of shown) {
		write(highlight(record) + "\n");
	}
};

const setFilter = term => {
	const t = term.trim();
	if (!t) {
		filter = null;
	} else {
		filter = { term: t, test: new RegExp(escapeRe(t), "i"), mark: new RegExp(escapeRe(t), "gi") };
	}

	redraw();
};

const printHelp = () => {
	write("\n" + bold("keys") + "\n");
	write(`  ${yellow("/")}       type a search term, then Enter. Only matching entries are shown (whole MCP/API blocks), matches highlighted.\n`);
	write(`  ${yellow("Esc")}     clear the search and show everything again (while typing: cancel).\n`);
	write(`  ${yellow("c")}       clear the screen (history is kept, search still works on it).\n`);
	write(`  ${yellow("?")}       this help.\n`);
	write(`  ${yellow("Ctrl+C")}  quit (stops the MCP server too).\n\n`);
};

const handleKey = (str, key) => {
	if (key?.ctrl && key.name === "c") {
		process.emit("SIGINT");
		return;
	}

	if (typing !== null) {
		if (key?.name === "return") {
			write("\n");
			const term = typing;
			typing = null;
			setFilter(term);
		} else if (key?.name === "escape") {
			typing = null;
			write("\n");
			redraw();
		} else if (key?.name === "backspace") {
			if (typing.length > 0) {
				typing = typing.slice(0, -1);
				write("\b \b");
			}
		} else if (str && !key?.ctrl && !key?.meta && str >= " ") {
			typing += str;
			write(str);
		}

		return;
	}

	if (str === "/") {
		typing = filter?.term ?? "";
		write("\n" + yellow("search: ") + typing);
	} else if (key?.name === "escape") {
		if (filter) {
			setFilter("");
		}
	} else if (str === "c") {
		clearScreen();
		printHeader();
	} else if (str === "?" || str === "h") {
		printHelp();
	}
};

process.on("SIGINT", () => {
	if (logcatProc) {
		logcatProc.kill();
	}

	process.exit(0);
});

if (process.stdin.isTTY) {
	emitKeypressEvents(process.stdin);
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("keypress", handleKey);
}

if (INITIAL_GREP) {
	setFilter(INITIAL_GREP);
} else {
	clearScreen();
	printHeader();
}

followLogcat();
