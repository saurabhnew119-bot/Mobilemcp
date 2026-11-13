#!/usr/bin/env node
// Single-terminal log viewer for mobile-mcp + an Android app under test.
//
//   node scripts/dev-logs.mjs [--package com.mli.mspace] [--device emulator-5554]
//                             [--port 3100] [--compact] [--full] [--headers]
//                             [--all-logcat] [--no-server] [--no-color] [--no-clear]
//                             [--grep <term>] [--log-file out.log]
//                             [--slow <ms>] [--watch <api path or part of it>]
//
// Responses are shown complete and pretty-printed by default; --compact
// shortens bodies to one line and long tool results to 12 lines.
//
// Keys while running: "/" search (filter + highlight, including earlier
// entries), Esc clear search, "c" clear screen, "x" clear screen + history,
// "r" rerun (restart the MCP server and logcat, fresh screen), "e" problems
// only, "w" watch an API, "?" help, Ctrl+C quit.
//
// Problems are detected while the app runs: failed API calls (HTTP 4xx/5xx,
// or a 200 whose body says status "Failure", statusCode >= 400 or
// success: false), API calls slower than --slow ms (default 2000), error
// and crash logs, and MCP tool errors. Each is tagged FAIL / SLOW / ERROR,
// and "e" switches to a view that shows only those (plus watched API calls).
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
// API calls slower than this are flagged SLOW.
const SLOW_MS = Number(opt("slow", "2000")) || 2000;

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
// Each entry: { text, issue: "fail" | "slow" | "error" | null, api: full URL of an API call or null }
const history = [];
let filter = null; // { term, test: RegExp, mark: RegExp }
let typing = null; // text being typed after "/" or "w", or null
let typingFor = "search"; // what Enter applies the typed text to: "search" | "watch"
let issuesOnly = false; // "e": show only problems and watched API calls
let watchTerm = opt("watch", null); // "w": API path (or part of it) to watch
const counts = { fail: 0, slow: 0, error: 0, watched: 0 };

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matches = text => !filter || filter.test.test(stripAnsi(text));
const highlight = text => (filter ? text.replace(filter.mark, m => c("7", m)) : text);
const isWatched = entry => Boolean(watchTerm && entry.api && entry.api.toLowerCase().includes(watchTerm.toLowerCase()));
const isVisible = entry => (!issuesOnly || entry.issue || isWatched(entry)) && matches(entry.text);
const render = entry => (isWatched(entry) ? bold(magenta("[WATCH] ")) : "") + highlight(entry.text);

const out = (text, meta = {}) => {
	const entry = { text, issue: meta.issue ?? null, api: meta.api ?? null };
	history.push(entry);
	if (history.length > MAX_HISTORY) {
		history.shift();
	}

	// "related" lines (stack frames under an error) show in the problems view but are not counted again.
	if (entry.issue && !meta.related) {
		counts[entry.issue]++;
	}

	if (isWatched(entry)) {
		counts.watched++;
	}

	if (LOG_FILE) {
		appendFileSync(LOG_FILE, stripAnsi(render(entry)) + "\n");
	}

	if (typing === null && isVisible(entry)) {
		write(render(entry) + "\n");
	}
};

// Short coloured tags put in front of a problem entry.
const TAG = {
	fail: () => bold(red("[FAIL]")),
	slow: () => bold(yellow("[SLOW]")),
	error: () => bold(red("[ERROR]")),
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

const box = (title, lines, footer, meta) => {
	const block = [title, ...lines.map(l => `${dim("|")}  ${l}`), `${dim("+--")} ${footer ?? ""}`, ""];
	out(block.join("\n"), meta);
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
	const failed = Boolean(response.error || response.result?.isError || Number(status) >= 400);
	const title = `${dim("+--")} ${failed ? TAG.error() + " " : ""}${bold(cyan("MCP"))} ${dim("#" + id)}  ${dim(now())}  ${bold(method)}${tool ? "  " + magenta(tool) : ""}`;
	const lines = [];
	const args = describeArgs(request.params?.arguments ?? (method === "tools/call" ? {} : request.params));
	if (args) {
		lines.push(`${dim("args   ")} ${args}`);
	}

	for (const l of summarizeResult(request, response)) {
		lines.push(`${dim("result ")} ${l}`);
	}

	box(title, lines, `${statusColor(status)} ${dim("-")} ${ms} ms`, { issue: failed ? "error" : null });
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

// "340 ms", "1563ms", "1.5 s" -> milliseconds (NaN if unknown).
const parseDurationMs = text => {
	const m = String(text ?? "").match(/([\d.]+)\s*(ms|s)?\b/i);
	if (!m) {
		return NaN;
	}

	return Number(m[1]) * (m[2]?.toLowerCase() === "s" ? 1000 : 1);
};

// Many backends answer HTTP 200 with a failure inside the body, e.g.
// { "status": "Failure", "statusCode": 498, "message": "User is already logged in from another device" }.
const bodyFailure = body => {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return null;
	}

	const status = String(body.status ?? "");
	const code = Number(body.statusCode ?? body.code);
	if (/^(fail|failure|failed|error)$/i.test(status) || code >= 400 || body.success === false || body.isSuccess === false) {
		const parts = [];
		if (status) parts.push(`status "${status}"`);
		if (code >= 400) parts.push(`statusCode ${code}`);
		if (body.success === false || body.isSuccess === false) parts.push("success: false");
		const message = body.message ?? body.errorMessage ?? body.error;
		return parts.join(", ") + (message ? `: ${typeof message === "object" ? JSON.stringify(message) : message}` : "");
	}

	return null;
};

// Why an API call is a problem: { issue: "fail" | "slow" | null, reasons: [...] }.
const apiProblems = f => {
	const reasons = [];
	let issue = null;
	const httpStatus = Number((f.STATUS ?? "").trim());
	if (httpStatus >= 400) {
		reasons.push(red(`HTTP ${httpStatus}`));
		issue = "fail";
	}

	if (f.ERROR && !/^No Error/i.test(f.ERROR.trim()) && !issue) {
		reasons.push(red("request error (see below)"));
		issue = "fail";
	}

	const inBody = bodyFailure(f.RESPONSE);
	if (inBody) {
		reasons.push(red(`response says ${inBody}`));
		issue = "fail";
	}

	const ms = parseDurationMs(f.DURATION);
	const slow = ms > SLOW_MS;
	if (slow) {
		reasons.push(yellow(`took ${ms} ms (slow limit ${SLOW_MS} ms)`));
		issue ??= "slow";
	}

	return { issue, slow, reasons };
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
	const problems = apiProblems(f);
	const tags = [problems.issue === "fail" ? TAG.fail() : "", problems.slow ? TAG.slow() : ""].filter(Boolean).join(" ");
	const duration = (f.DURATION ?? "").trim();
	const title = `${dim("+--")} ${tags ? tags + " " : ""}${bold(blue("APP API"))}  ${dim(now())}  ${bold(f.METHOD ?? "?")} ${path}   ${statusColor(status)} ${dim("-")} ${problems.slow ? bold(yellow(duration)) : duration}${f.SCREEN ? dim("   screen=" + f.SCREEN.trim()) : ""}`;
	const body = problems.reasons.map(r => `${bold("problem ")} ${r}`);
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

	box(title, body, dim(host), { issue: problems.issue, api: f.URL ?? path });
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
let frameIssue = null; // the issue of the line a stack trace belongs to

const flushFrames = () => {
	if (framesHidden > 0) {
		out(`${bold(blue("APP"))}  ${dim(now())}  ${dim(`      ...(+${framesHidden} more frames)`)}`, { issue: frameIssue, related: true });
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
			const isError = /ERROR|FATAL/i.test(lvl);
			out(`${isError ? TAG.error() + " " : ""}${bold(blue("APP"))}  ${dim(now())}  ${tone(lvl.padEnd(5))}  ${tone(text)}`, { issue: isError ? "error" : null });
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
		// Stack frames belong to the error above them: same visibility, no new tag or count.
		const isError = level === "E" || level === "F" || (tag === "AndroidRuntime" && /FATAL/.test(msg));
		if (!isFrame) {
			frameIssue = isError ? "error" : null;
		}

		const showTag = isError && !isFrame;
		out(`${showTag ? TAG.error() + " " : ""}${bold(blue("APP"))}  ${dim(now())}  ${tone(level)}/${tone(tag.replace(/^unknown:/, ""))}  ${tone(text)}`, { issue: isFrame ? frameIssue : isError ? "error" : null, related: isFrame });
	}
};

// Anything a child writes to stderr that is not part of the normal streams is
// shown with its origin, so a crash message can never appear without a label.
const tagStderr = (stream, label) => {
	readLines(stream, line => {
		if (line.trim()) {
			out(`${TAG.error()} ${bold(red(label))}  ${dim(now())}  ${red(line)}`, { issue: "error" });
		}
	});
};

const readLines = (stream, handler) => {
	createInterface({ input: stream, crlfDelay: Infinity }).on("line", handler);
};

// ---------- start server ----------
let serverProc = null;

const startServer = () => {
	const server = spawn(process.execPath, [resolve(ROOT, "lib/index.js"), "--listen", `127.0.0.1:${PORT}`], {
		cwd: ROOT,
		env: { ...process.env, MOBILEMCP_LOG_REQUESTS: "1" },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	serverProc = server;
	readLines(server.stderr, handleMcpLine);
	readLines(server.stdout, handleMcpLine);
	server.on("exit", code => {
		if (serverProc !== server) {
			return; // stopped on purpose by a rerun or quit
		}

		out(red(`MCP server exited with code ${code}`));
		process.exit(code ?? 1);
	});
};

// Stop the server and wait until it is gone, so the port is free again.
const stopServer = () => new Promise(done => {
	const server = serverProc;
	serverProc = null;
	if (!server || server.exitCode !== null || server.signalCode !== null) {
		done();
		return;
	}

	server.once("exit", () => done());
	server.kill();
});

if (!NO_SERVER) {
	startServer();
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

const resetHistory = () => {
	history.length = 0;
	for (const key of Object.keys(counts)) {
		counts[key] = 0;
	}
};

// Forget everything printed so far, not just what is on screen.
const resetState = () => {
	resetHistory();
	pending.clear();
	mcpState = null;
	suppressUntilMarker = false;
	apiBlock = null;
	frameCount = 0;
	framesHidden = 0;
};

const followLogcat = () => {
	const pid = pidOf();
	if (pid && pid !== currentPid) {
		if (runCount > 0) {
			if (CLEAR_ON_RESTART) {
				resetHistory();
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
	write(dim("keys:  /  search   Esc  clear search   e  problems only   w  watch API   c  clear screen   x  clear screen + history   r  rerun   ?  help   Ctrl+C  quit") + "\n");
	write(dim(`responses: ${COMPACT ? "compact (--compact)" : "complete, pretty-printed (use --compact to shorten)"}   noise filter: ${FULL || ALL_LOGCAT ? "off" : "on (--full or --all-logcat to disable)"}`) + "\n");
	const problemText = `problems: ${counts.fail} failed API   ${counts.slow} slow API (over ${SLOW_MS} ms)   ${counts.error} errors`;
	write((counts.fail || counts.error ? red(problemText) : counts.slow ? yellow(problemText) : dim(problemText)) + "\n");
	if (watchTerm) {
		write(magenta(`watching API: "${watchTerm}"  -  ${counts.watched} calls so far  -  w then Enter on empty text to stop`) + "\n");
	}

	if (issuesOnly) {
		write(yellow(`view: problems only${watchTerm ? " + watched API" : ""}  -  e to show everything`) + "\n");
	}

	if (filter) {
		const count = history.filter(isVisible).length;
		write(yellow(`filter: "${filter.term}"  -  ${count} of ${history.length} entries match  -  Esc to clear`) + "\n");
	}

	write("\n");
};

// Redraw the screen from history, applying the current filter and view.
const redraw = () => {
	clearScreen();
	printHeader();
	const visible = history.filter(isVisible);
	const narrowed = filter || issuesOnly;
	const shown = narrowed ? visible : visible.slice(-300);
	if (visible.length > shown.length) {
		write(dim(`...(${visible.length - shown.length} earlier entries not shown, use / to search them)`) + "\n");
	}

	if (issuesOnly && visible.length === 0) {
		write(green(`no problems${filter ? " matching the search" : ""} so far`) + "\n");
	}

	for (const entry of shown) {
		write(render(entry) + "\n");
	}
};

const setWatch = term => {
	const t = term.trim();
	watchTerm = t || null;
	counts.watched = watchTerm ? history.filter(isWatched).length : 0;
	redraw();
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
	write(`  ${yellow("e")}       problems only: failed API calls [FAIL], slow API calls [SLOW], errors/crashes [ERROR],\n`);
	write(`          plus watched API calls. Press e again to show everything. Counts are in the header.\n`);
	write(`  ${yellow("w")}       watch an API: type a path or part of it (e.g. powerbi-info), Enter. Its calls get a [WATCH] tag\n`);
	write(`          and stay visible in the problems view. Empty text + Enter stops watching.\n`);
	write(`          A call is FAIL on HTTP 4xx/5xx or when the body says status "Failure", statusCode >= 400 or success: false.\n`);
	write(`          It is SLOW when it takes longer than ${SLOW_MS} ms (start with --slow <ms> to change).\n`);
	write(`  ${yellow("c")}       clear the screen (history is kept, search still works on it).\n`);
	write(`  ${yellow("x")}       clear the screen and the history (start again with an empty log).\n`);
	write(`  ${yellow("r")}       rerun: restart the MCP server and re-attach logcat, with a fresh screen.\n`);
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
			if (typingFor === "watch") {
				setWatch(term);
			} else {
				setFilter(term);
			}
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
		typingFor = "search";
		typing = filter?.term ?? "";
		write("\n" + yellow("search: ") + typing);
	} else if (str === "w") {
		typingFor = "watch";
		typing = watchTerm ?? "";
		write("\n" + magenta("watch API (path or part of it, empty = stop): ") + typing);
	} else if (str === "e") {
		issuesOnly = !issuesOnly;
		redraw();
	} else if (key?.name === "escape") {
		if (filter) {
			setFilter("");
		}
	} else if (str === "c") {
		clearScreen();
		printHeader();
	} else if (str === "x") {
		resetState();
		clearScreen();
		printHeader();
		out(dim(`${now()}  screen and history cleared`));
	} else if (str === "r") {
		rerun();
	} else if (str === "?" || str === "h") {
		printHelp();
	}
};

// Restart everything this viewer runs, in the same terminal window.
let rerunning = false;
const rerun = async () => {
	if (rerunning) {
		return;
	}

	rerunning = true;
	write("\n" + yellow("rerunning...") + "\n");
	if (logcatProc) {
		logcatProc.removeAllListeners("exit");
		logcatProc.kill();
		logcatProc = null;
	}

	currentPid = null;
	runCount = 0;
	if (!NO_SERVER) {
		await stopServer();
	}

	resetState();
	clearScreen();
	printHeader();
	if (!NO_SERVER) {
		startServer();
	}

	out(dim(`${now()}  rerun: ${NO_SERVER ? "" : "MCP server restarted, "}re-attaching logcat`));
	rerunning = false;
};

process.on("SIGINT", () => {
	if (serverProc) {
		const server = serverProc;
		serverProc = null;
		server.kill();
	}

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
