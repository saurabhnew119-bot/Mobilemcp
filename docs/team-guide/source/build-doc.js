// Builds the Mobilemcp team guide as a Monocept-branded Word document.
const fs = require("fs");
const path = require("path");
const {
	Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, Header, Footer,
	HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType, LevelFormat, LevelSuffix,
	PageNumber, PageBreak, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
	TextWrappingType, PageBorderDisplay, PageBorderOffsetFrom, PageBorderZOrder, VerticalAlign,
} = require("docx");

const OUT = process.argv[2] || path.join(__dirname, "Mobilemcp-Team-Guide.docx");
// Repository the team clones from. Replace once the branch is pushed to the team's fork.
const REPO_URL = process.env.REPO_URL || "https://github.com/<your-org>/mobile-mcp.git";
const BRANCH = process.env.REPO_BRANCH || "main";
const UPSTREAM_URL = "https://github.com/mobile-next/mobile-mcp.git";
const BRAND = "C:/Users/SaurabhKumar/.claude/skills/synced/5c8cd8f7-9f34-4af7-9d7c-75b19a8c8db4_a8c47802-5bc4-475a-b681-5660c29d7f23/monocept-brand/assets";

// ---- brand constants ----
const ORANGE = "FF601F", GREEN = "96C93D", DARK = "333333", MID = "666666", LINE = "BFBFBF", LIGHT = "D9D9D9", BODY = "222222";
const HEAD_FONT = "Harabara Mais", BODY_FONT = "Palatino Linotype";
const SKILL_VERSION = "2.3", SKILL_DATE = "2026-08-25";

// A4, margins 2.5cm (top 3cm), header/footer distance 1.25cm
const PAGE_W = 11906, PAGE_H = 16838, M_LEFT = 1417, M_RIGHT = 1417, M_TOP = 1701, M_BOTTOM = 1417;
const USABLE = PAGE_W - M_LEFT - M_RIGHT; // 9072 dxa

// ---- helpers ----
const run = (text, o = {}) => new TextRun({ text, font: o.font || BODY_FONT, size: o.size || 22, color: o.color || BODY, bold: o.bold, italics: o.italics, ...(o.extra || {}) });
const p = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [run(children, o.run)], spacing: { before: o.before ?? 0, after: o.after ?? 120, line: 276 }, alignment: o.align, keepNext: o.keepNext, ...(o.extra || {}) });
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t, font: HEAD_FONT, size: 40, bold: true, color: ORANGE })] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t, font: HEAD_FONT, size: 32, color: ORANGE })] });
const h3 = t => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: t, font: BODY_FONT, size: 26, bold: true, color: DARK })] });
const rule = () => new Paragraph({ children: [], spacing: { before: 120, after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ORANGE, space: 1 } } });
const bullet = (parts, level = 0) => new Paragraph({ numbering: { reference: "bullets", level }, spacing: { after: 80, line: 276 }, children: typeof parts === "string" ? [run(parts)] : parts });
let stepRef = 0;
const steps = items => { stepRef++; return items.map(it => new Paragraph({ numbering: { reference: `steps${stepRef}`, level: 0 }, spacing: { after: 80, line: 276 }, children: typeof it === "string" ? [run(it)] : it })); };
const code = lines => lines.map((l, i) => new Paragraph({
	children: [run(l, { size: 20, color: DARK })],
	spacing: { before: 0, after: i === lines.length - 1 ? 160 : 0, line: 260 },
	shading: { type: ShadingType.CLEAR, fill: LIGHT, color: "auto" },
	indent: { left: 200, right: 200 },
	border: i === 0 ? { top: { style: BorderStyle.SINGLE, size: 2, color: LINE, space: 4 } } : (i === lines.length - 1 ? { bottom: { style: BorderStyle.SINGLE, size: 2, color: LINE, space: 4 } } : undefined),
}));
const callout = text => new Paragraph({
	children: [run(text, { size: 24, italics: true, color: DARK })],
	spacing: { before: 120, after: 200, line: 276 },
	indent: { left: 200, right: 200 },
	shading: { type: ShadingType.CLEAR, fill: "FFF5F0", color: "auto" },
	border: { left: { style: BorderStyle.SINGLE, size: 32, color: ORANGE, space: 8 } },
});
const caption = t => new Paragraph({ children: [run(t, { size: 18, italics: true, color: MID })], alignment: AlignmentType.CENTER, spacing: { before: 80, after: 240 } });
const bold = t => run(t, { bold: true });

const pngSize = file => { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
const figure = (file, widthPx) => {
	const { w, h } = pngSize(file);
	return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 0 }, keepNext: true, children: [new ImageRun({ type: "png", data: fs.readFileSync(file), transformation: { width: widthPx, height: Math.round(widthPx * h / w) } })] });
};

// Body table. treatment: "orange" (<=3 light columns) or "grey" (dense)
const table = (headers, rows, widthsPct, treatment = "grey") => {
	const fill = treatment === "orange" ? ORANGE : MID;
	const widths = widthsPct.map(pc => Math.round(USABLE * pc / 100));
	widths[widths.length - 1] += USABLE - widths.reduce((a, b) => a + b, 0);
	const cellOpts = (w, shade) => ({ width: { size: w, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 100, right: 100 }, verticalAlign: VerticalAlign.CENTER, shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: "auto" } : undefined });
	const cellPara = (content, isHeader) => {
		const items = Array.isArray(content) ? content : [content];
		return items.map(c => new Paragraph({ spacing: { before: 0, after: 0, line: 260 }, children: typeof c === "string" ? [isHeader ? new TextRun({ text: c, font: HEAD_FONT, size: 22, bold: true, color: "FFFFFF" }) : run(c, { color: DARK })] : c }));
	};
	const headerRow = new TableRow({ tableHeader: true, children: headers.map((h, i) => new TableCell({ ...cellOpts(widths[i], fill), children: cellPara(h, true) })) });
	const bodyRows = rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => new TableCell({ ...cellOpts(widths[i], ri % 2 === 1 ? LIGHT : undefined), children: cellPara(c, false) })) }));
	const b = (size) => ({ style: BorderStyle.SINGLE, size, color: fill });
	return new Table({
		width: { size: USABLE, type: WidthType.DXA }, columnWidths: widths,
		borders: { top: b(4), bottom: b(4), left: b(4), right: b(4), insideHorizontal: b(2), insideVertical: b(2) },
		rows: [headerRow, ...bodyRows],
	});
};
const spacer = () => new Paragraph({ children: [], spacing: { before: 0, after: 160 } });

// ---- footer: fixed-width 3-column table + version stamp row ----
const footerText = (children) => new Paragraph({ spacing: { before: 0, after: 0 }, children: children.map(c => typeof c === "string" ? new TextRun({ text: c, font: BODY_FONT, size: 18, italics: true, color: MID }) : c) });
const fw = [Math.round(USABLE * 0.48), Math.round(USABLE * 0.30), 0]; fw[2] = USABLE - fw[0] - fw[1];
const noSide = { left: { style: BorderStyle.NONE, size: 0, color: "auto" }, right: { style: BorderStyle.NONE, size: 0, color: "auto" }, bottom: { style: BorderStyle.NONE, size: 0, color: "auto" } };
const footer = new Footer({ children: [new Table({
	width: { size: USABLE, type: WidthType.DXA }, columnWidths: fw,
	borders: { top: { style: BorderStyle.SINGLE, size: 4, color: ORANGE }, bottom: { style: BorderStyle.NONE, size: 0, color: "auto" }, left: { style: BorderStyle.NONE, size: 0, color: "auto" }, right: { style: BorderStyle.NONE, size: 0, color: "auto" }, insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" }, insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" } },
	rows: [
		new TableRow({ children: [
			new TableCell({ width: { size: fw[0], type: WidthType.DXA }, borders: noSide, margins: { top: 60, bottom: 0, left: 0, right: 0 }, children: [footerText(["Monocept® Confidential – All rights reserved"])] }),
			new TableCell({ width: { size: fw[1], type: WidthType.DXA }, borders: noSide, margins: { top: 60, bottom: 0, left: 0, right: 0 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: "https://www.monocept.com", font: BODY_FONT, size: 18, italics: true, color: MID })] })] }),
			new TableCell({ width: { size: fw[2], type: WidthType.DXA }, borders: noSide, margins: { top: 60, bottom: 0, left: 0, right: 0 }, children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], font: BODY_FONT, size: 18, italics: true, color: MID })] })] }),
		] }),
		new TableRow({ children: [
			new TableCell({ columnSpan: 3, width: { size: USABLE, type: WidthType.DXA }, borders: { ...noSide, top: { style: BorderStyle.NONE, size: 0, color: "auto" } }, margins: { top: 0, bottom: 0, left: 0, right: 0 }, children: [footerText([`Formatted with Monocept Brand Skill v${SKILL_VERSION} (${SKILL_DATE})`])] }),
		] }),
	],
}) ] });

// ---- header: watermark (behind text) + empty right-aligned paragraph for the logo (inserted by Word) ----
const WM_EMU = 6350400, PAGE_H_EMU = 10692000;
const header = new Header({ children: [
	new Paragraph({ children: [new ImageRun({ type: "png", data: fs.readFileSync(path.join(BRAND, "monocept_watermark_x.png")), transformation: { width: 667, height: 667 },
		floating: { horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 304800 }, verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: Math.round((PAGE_H_EMU - WM_EMU) / 2) }, behindDocument: true, allowOverlap: false, lockAnchor: false, zIndex: 1, wrap: { type: TextWrappingType.NONE } } })], spacing: { before: 0, after: 0 } }),
	new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 120, after: 0 }, children: [
		new ImageRun({ type: "svg", data: fs.readFileSync(path.join(BRAND, "monocept_logo_color.svg")), fallback: { type: "png", data: fs.readFileSync(path.join(__dirname, "logo-fallback.png")) }, transformation: { width: 132, height: 37 } }),
	] }),
] });

// ---- numbering ----
const headingLevel = (lvl, text) => ({ level: lvl, format: LevelFormat.DECIMAL, text, alignment: AlignmentType.LEFT, suffix: LevelSuffix.SPACE, style: { paragraph: { indent: { left: 0, hanging: 0 } } } });
const numbering = { config: [
	{ reference: "headings", levels: [headingLevel(0, "%1."), headingLevel(1, "%1.%2."), headingLevel(2, "%1.%2.%3."), headingLevel(3, "%1.%2.%3.%4.")] },
	{ reference: "bullets", levels: [
		{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 300 } } } },
		{ level: 1, format: LevelFormat.BULLET, text: "\u2013", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1000, hanging: 300 } } } },
	] },
	...Array.from({ length: 8 }, (_, i) => ({ reference: `steps${i + 1}`, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 340 } } } }] })),
] };

// =====================================================================
// CONTENT
// =====================================================================
const FIG_W = 600; // px at 96 dpi ~ 15.9 cm
const children = [];

// ---- cover ----
children.push(
	new Paragraph({ spacing: { before: 2400, after: 0 }, children: [] }),
	new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: "Mobilemcp", font: HEAD_FONT, size: 72, bold: true, color: ORANGE })] }),
	p([run("Driving the mSpace Android app from an AI client, with every request and log in one place", { size: 28, color: DARK })], { after: 120 }),
	p([run("Team guide: how it works, how to set it up, and what each of us needs to resolve on our own machine", { size: 24, italics: true, color: MID })], { after: 600 }),
	table(["Item", "Detail"], [
		["Project", "Mobilemcp (fork of mobile-next/mobile-mcp with our logging and dev-viewer additions)"],
		["Get the code", `git clone -b ${BRANCH} ${REPO_URL} Mobilemcp`],
		["Target app", "mSpace Android app (package com.mli.mspace), Axis Max Life UAT backend"],
		["Audience", "QA automation and mobile engineers who will run or extend the automation"],
		["Version", "1.0, 4 November 2026"],
		["Status", "Working on one Windows 11 machine with an Android emulator; ready for the team to replicate"],
	], [25, 75], "orange"),
	spacer(),
	callout("In one line: an AI client sends tool calls to a small Node server, the server drives the Android emulator through adb, and a single terminal shows what was asked, what the device did and what the app called on the backend."),
	new Paragraph({ children: [new PageBreak()] }),
);

// ---- 1. Purpose ----
children.push(
	h1("What this is and why we built it"),
	p("Testing mSpace by hand is slow and hard to reproduce. mobile-mcp is an open-source Model Context Protocol (MCP) server that lets an AI client such as Claude Code or Cursor operate a phone: launch apps, tap, type, swipe, read the screen and take screenshots. We cloned it as the Mobilemcp project, built it, and ran it against the mSpace app on an Android emulator."),
	p("Out of the box the server is silent about what it does, and the app's own API traffic lives in a separate logcat stream. We added two things so a tester can follow a run without juggling windows:"),
	bullet([bold("Request and response logging"), run(" on the server's HTTP endpoint, so every tool call and its reply is printed in full.")]),
	bullet([bold("A single-terminal log viewer"), run(" that merges those server logs with the app's logcat output, parses the app's API request and response blocks, filters emulator noise, clears itself when the app is rerun, and lets you search everything with a keypress.")]),
	p("This guide explains the moving parts, the setup steps, and the dependencies each team member has to sort out locally before it works for them."),
	rule(),
);

// ---- 2. How it works ----
children.push(
	h1("How it works"),
	h2("Components and data flow"),
	figure(path.join(__dirname, "fig1-how-it-works.png"), FIG_W),
	caption("Figure 1. Components, the path of one tool call, and the two log feeds that the dev viewer merges."),
	table(["Component", "What it does", "Where it runs"], [
		["MCP client", "Sends JSON-RPC tool calls such as mobile_launch_app or mobile_click_on_screen_at_coordinates. Claude Code, Cursor, Claude Desktop, or plain curl against the HTTP endpoint.", "Your laptop"],
		["mobile-mcp server", "Node.js process built from this repo (lib/index.js). Two modes: stdio (what MCP clients use) or Streamable HTTP on 127.0.0.1:3100/mcp (what curl and the dev viewer use).", "Your laptop"],
		["mobilecli and adb", "Bundled helper binary plus the Android Debug Bridge from the Android SDK. They turn a tool call into device commands and return screenshots or the UI element tree.", "Your laptop, talking to the device"],
		["Android emulator or device", "An Android Virtual Device (we use Medium_Phone_API_37.0) or a physical phone with USB debugging. mSpace must be installed on it.", "Your laptop or USB"],
		["mSpace app and its backend", "The React Native app calls uatapi.maxlifeinsurance.com itself. mobile-mcp never talks to that backend; we only observe those calls through logcat.", "Device plus UAT network"],
		["Dev log viewer", "scripts/dev-logs.mjs, run with npm run dev:logs. Starts the server, tails logcat for the mSpace process and prints both feeds in one terminal with search.", "Your laptop"],
	], [22, 56, 22], "grey"),
	spacer(),
	h2("Life of one tool call"),
	...steps([
		"The client posts a tools/call request, for example mobile_click_on_screen_at_coordinates with a device id and x, y.",
		"The request-logger middleware prints the request body with a sequence number.",
		"The tool handler resolves the device by its id. For emulators the id is the AVD name (Medium_Phone_API_37.0), not the adb serial.",
		"mobilecli or adb executes the action on the device: input tap, am start, screencap, uiautomator dump and so on.",
		"The result text, screenshot or element list is returned as the JSON-RPC response, and the middleware prints it with the HTTP status and elapsed time.",
		"Meanwhile the app reacts: it calls its backend, logs the API request and response to logcat, and the viewer prints that block next to the tool call that caused it.",
	]),
	callout("Device id matters: a call made with the adb serial emulator-5554 is rejected with 'device not found'. Always use the id returned by mobile_list_available_devices."),
	h2("The two run modes"),
	table(["Mode", "Command", "Use it when"], [
		["stdio", "npm start   (or: node lib/index.js)", "An MCP client launches the server itself. Claude Code, Cursor and Claude Desktop do this. Nothing is printed to a terminal because stdin and stdout carry the protocol."],
		["HTTP", "node lib/index.js --listen 127.0.0.1:3100", "You want to drive it with curl, a script, or watch it in the dev viewer. The dev viewer starts this mode for you."],
	], [14, 36, 50], "grey"),
	spacer(),
	rule(),
);

// ---- 3. What we added ----
children.push(
	h1("What we added on top of mobile-mcp"),
	h2("Request and response logging"),
	p([run("File: "), bold("src/request-logger.ts"), run(", wired into "), bold("src/index.ts"), run(". It is an Express middleware on the /mcp route. For every request it prints the JSON body; for every response it captures the Server-Sent Events stream, extracts the JSON-RPC payload and prints it with the status and the time taken. Set "), bold("MOBILEMCP_LOG_REQUESTS=0"), run(" to switch it off.")]),
	h2("Single-terminal dev log viewer"),
	p([run("File: "), bold("scripts/dev-logs.mjs"), run(", run with "), bold("npm run dev:logs"), run(". It replaces three separate windows (server, server log file, adb logcat) with one feed.")]),
	table(["Feature", "What you see"], [
		["MCP blocks", "One block per tool call: tool name, arguments, the complete result, HTTP status and duration. Pass --compact to cut long results to 12 lines."],
		["APP API blocks", "The app's own API logs parsed into method, path, status, duration, screen name, and the complete request and response bodies, pretty-printed. Headers are hidden unless you pass --headers, and then tokens are redacted."],
		["App log lines", "React Native INFO, DEBUG and ERROR lines, Java exceptions, crashes. Emulator chatter such as garbage-collection stats and graphics warnings is filtered out. Stack traces are collapsed to three frames."],
		["Follows reruns", "When mSpace is killed and relaunched the viewer detects the new process, clears the screen and starts a fresh run. The log file copy keeps all runs."],
		["Search", "Press / and type a term: only matching entries are shown, whole blocks stay together, matches are highlighted, and earlier entries are included. Esc clears it."],
		["Labelled errors", "Anything a child process writes to stderr is shown with an ADB or ADB LOGCAT label, so a crash message can never appear without a source."],
	], [22, 78], "orange"),
	spacer(),
	h3("Keys while the viewer is running"),
	table(["Key", "Action"], [
		["/", "Start a search. Type the term, press Enter."],
		["Esc", "Clear the search and show everything again. While typing, cancel."],
		["c", "Clear the screen. History is kept, so search still covers it."],
		["?", "Show help."],
		["Ctrl+C", "Quit. The server stops with it."],
	], [18, 82], "orange"),
	spacer(),
	h3("Useful flags"),
	table(["Flag", "Effect"], [
		["--package <id>", "Follow a different app. Default com.mli.mspace."],
		["--device <serial>", "Use a different adb device. Default emulator-5554."],
		["--port <n>", "HTTP port for the server. Default 3100."],
		["--grep <term>", "Start with a search already applied."],
		["--compact", "Shorten bodies to one line and long tool results to 12 lines, so more entries fit on screen."],
		["--full", "Everything: no noise filter, all stack frames, complete bodies."],
		["--headers", "Show request headers with Authorization and API keys redacted."],
		["--all-logcat", "Show every logcat line from the app process."],
		["--no-clear", "Keep logs from earlier runs on screen."],
		["--no-server", "Do not start the server; only tail the app logs."],
		["--log-file <path>", "Also write a plain-text copy of everything, never cleared."],
	], [28, 72], "orange"),
	spacer(),
	rule(),
);

// ---- 4. Setup flow ----
children.push(
	h1("Setup and run flow"),
	figure(path.join(__dirname, "fig2-setup-flow.png"), FIG_W),
	caption("Figure 2. One-time setup on the left, daily routine on the right. Orange outlines mark the points where something must be resolved locally."),
	h2("Step by step"),
	h3("One-time setup"),
	...steps([
		[run("Install the prerequisites in the table in the next section. Accept the Android SDK licences in Android Studio and make sure "), bold("adb"), run(" is on your PATH or at %LOCALAPPDATA%\\Android\\Sdk\\platform-tools.")],
		"Clone the repository and build it:",
	]),
	...code([`git clone -b ${BRANCH} ${REPO_URL} Mobilemcp`, "cd Mobilemcp", "npm install", "npm run build"]),
	...steps([
		[run("Create an Android Virtual Device in Android Studio (Device Manager, Medium Phone, a recent API level) or enable USB debugging on a phone. Confirm with "), bold("adb devices"), run(".")],
		"Install the mSpace build on the device (adb install <apk>). Ask the mobile team for the current UAT APK.",
		"Open the Mobilemcp folder in VS Code (or Visual Studio with the Node.js workload).",
	]),
	h3("Every day"),
	...steps([
		"Start the emulator and wait until adb devices shows it as 'device', not 'offline'.",
		[run("In the Mobilemcp folder run "), bold("npm run dev:logs"), run(". The terminal shows the server start line and 'attached to com.mli.mspace' once the app is running.")],
		"Drive the app from your MCP client or with curl against http://127.0.0.1:3100/mcp. Start with mobile_list_available_devices and use the returned id in every call.",
		"Read the feed. Press / to search, for example /login or /quotes, and Esc to go back.",
	]),
	h2("Connecting an MCP client"),
	p("Point your client at the local build instead of the published npx package so it picks up the logging changes. For Claude Code add a server entry like this (paths are examples):"),
	...code(['"mobile-mcp": {', '  "command": "node",', '  "args": ["C:\\\\Users\\\\<you>\\\\Mobilemcp\\\\lib\\\\index.js"]', '}']),
	p("Cursor and Claude Desktop take the same command and args. If your client supports HTTP MCP servers, use http://127.0.0.1:3100/mcp while the dev viewer is running."),
	h2("Smoke test"),
	table(["Check", "Command or action", "Expected result"], [
		["Device visible", "adb devices", "emulator-5554  device"],
		["Server up", "npm run dev:logs", "'streamable http server listening on http://127.0.0.1:3100/mcp'"],
		["Device seen by server", "tools/call mobile_list_available_devices", "One device with id Medium_Phone_API_37.0 and state online"],
		["App launches", "tools/call mobile_launch_app packageName=com.mli.mspace", "'Launched app com.mli.mspace' and APP API blocks for cognito-token, device-id and check-version"],
		["Screen readable", "tools/call mobile_list_elements_on_screen", "Element list with refs, text, ids and coordinates"],
		["Search works", "Press / then type cognito, Enter", "Only the matching blocks are shown with the term highlighted"],
	], [22, 36, 42], "grey"),
	spacer(),
	rule(),
);

// ---- 5. Dependencies ----
children.push(
	h1("Dependencies you need to resolve at your end"),
	p("Everything below is already working on the reference machine. Each team member has to put the same pieces in place locally. The third column tells you how to confirm it."),
	h2("Software to install"),
	table(["Dependency", "Why it is needed", "How to check or get it"], [
		["Git", "Clone the repository and pull updates.", "git --version. Install from git-scm.com."],
		["Node.js 20 or newer, with npm", "Runs the server and the dev viewer. The reference machine uses Node 24.", "node --version. Install the LTS build from nodejs.org."],
		["Android Studio with SDK platform-tools and emulator", "Provides adb, the emulator binary, system images and the Device Manager to create an AVD.", "Android Studio > SDK Manager: install 'Android SDK Platform-Tools' and 'Android Emulator'. Then adb --version."],
		["An Android Virtual Device, or a physical phone", "The server needs something to drive. The emulator needs hardware acceleration (Hyper-V or Windows Hypervisor Platform) which may need admin rights to enable.", "emulator -list-avds shows at least one AVD, or adb devices shows your phone with USB debugging on."],
		["mSpace UAT build (APK)", "The app under test. Not part of this repo.", "Get the current APK from the mobile team and adb install it."],
		["VS Code or Visual Studio", "Editing and running the project. Visual Studio needs the Node.js development workload; VS Code works as is.", "Open the Mobilemcp folder; the integrated terminal runs the npm scripts."],
		["An MCP client", "Claude Code, Cursor or Claude Desktop, if you want an AI to drive the app. curl is enough for manual tool calls.", "Add the server entry shown in the previous section."],
		["Windows Terminal or PowerShell", "The dev viewer uses ANSI colours and raw keyboard input for search. Windows Terminal renders both well.", "Run npm run dev:logs; the header line should be in colour and / should open the search prompt."],
	], [24, 40, 36], "grey"),
	spacer(),
	h2("Access and approvals"),
	table(["Need", "Who can resolve it", "Notes"], [
		["Repository access", "Repo owner", `Read access to ${REPO_URL} (branch ${BRANCH}). Ask the repo owner if the clone is refused. The original project lives at ${UPSTREAM_URL}, but that copy does not contain our changes.`],
		["mSpace UAT credentials", "Mobile team / QA lead", "The app logs in with an SSO ID. On the reference emulator 'Remember me' was on, so the app logged in by itself on every relaunch and hit the UAT login endpoint. Decide whether automated runs should do that."],
		["Network access to UAT", "IT / VPN", "The app must reach uatapi.maxlifeinsurance.com from the emulator. If you need VPN for UAT, the emulator uses the host's network, so connect the VPN first."],
		["npm registry access", "IT / proxy", "npm install needs registry.npmjs.org. On a corporate proxy set HTTP_PROXY and HTTPS_PROXY for npm."],
		["Admin rights for the emulator", "IT", "Enabling Hyper-V or Windows Hypervisor Platform and installing Android Studio may need local admin."],
		["Optional: server authentication", "Whoever exposes the HTTP port", "The HTTP server accepts unauthenticated calls on localhost. If you ever bind it to a non-local address, set MOBILEMCP_AUTH to a bearer token and keep port 3100 behind the firewall."],
	], [22, 20, 58], "grey"),
	spacer(),
	h2("Things we do not cover yet"),
	bullet("iOS. mobile-mcp supports iOS simulators and devices, but only from macOS with Xcode. Nothing in this guide was tested on iOS."),
	bullet("Remote cloud devices. mobile-mcp can allocate real devices from its cloud fleet. We have not evaluated the cost or the data-handling implications, so leave those tools unused."),
	bullet("Test scripts. Today the automation is driven interactively. Turning a flow into a repeatable script is the next step once the setup is on everyone's machine."),
	rule(),
);

// ---- 6. Known issues ----
children.push(
	h1("Known issues and troubleshooting"),
	table(["Symptom", "Cause", "What to do"], [
		["'Device \"emulator-5554\" not found'", "You passed the adb serial. The server identifies emulators by AVD name.", "Use the id from mobile_list_available_devices, for example Medium_Phone_API_37.0."],
		["First call right after boot fails with 'device not found', later calls work", "The device was still coming online.", "Wait for adb devices to show 'device' (not 'offline') and retry."],
		["Terminal shows '*** stack smashing detected ***: terminated' with no label", "Seen twice on the reference machine. It did not come from any stream the viewer reads. Most likely a short-lived adb.exe crash.", "Harmless so far. The viewer now labels every child's error output, so if it recurs the label tells you the source. Report it with the log file."],
		["Port 3100 already in use; the server exits silently", "An older server is still running.", "Stop old node processes (Task Manager, or Get-Process node) or run the viewer with --port 3101."],
		["check-version says the app version is no longer supported", "The UAT backend expects a newer build than the one installed.", "Install the current APK from the mobile team. This is an app or backend state, not a tooling fault."],
		["The app logs in by itself on launch", "'Remember me' is ticked with saved credentials.", "Untick it in the app before the next restart if automated runs must not log in."],
		["No APP lines in the viewer", "The app process is not running, or the package name differs.", "Launch the app; the viewer attaches within two seconds. Check with adb shell pidof com.mli.mspace."],
		["Claude Code says the mobile-mcp server timed out at startup", "The npx-based server entry downloads and starts slowly, or adb is not ready.", "Point the client at the local build (node lib/index.js) as shown earlier."],
		["Long warning lines from React Native or GFXSTREAM flood the feed", "Emulator noise.", "The viewer filters these by default. Use --all-logcat only when you really need everything."],
	], [30, 30, 40], "grey"),
	spacer(),
	rule(),
);

// ---- 7. Reference ----
children.push(
	h1("Reference"),
	h2("Get the code"),
	table(["What", "Where"], [
		["Team repository (with all recent changes)", REPO_URL],
		["Branch to use", BRANCH],
		["Clone command", `git clone -b ${BRANCH} ${REPO_URL} Mobilemcp`],
		["Update an existing clone", `git fetch origin && git checkout ${BRANCH} && git pull`],
		["Original upstream project (no Monocept changes)", UPSTREAM_URL],
	], [38, 62], "orange"),
	spacer(),
	h2("Files changed in this project"),
	table(["File", "Purpose"], [
		["src/request-logger.ts", "Express middleware that logs every MCP request and response on the HTTP endpoint."],
		["src/index.ts", "Registers the middleware on the HTTP server."],
		["scripts/dev-logs.mjs", "Single-terminal viewer: server start, logcat follow, API block parsing, noise filter, clear on rerun, search."],
		["package.json", "Adds the dev:logs script."],
	], [34, 66], "orange"),
	spacer(),
	h2("Commands at a glance"),
	...code([
		"npm install                      install dependencies",
		"npm run build                    compile TypeScript to lib/",
		"npm start                        server in stdio mode (for MCP clients)",
		"node lib/index.js --listen 127.0.0.1:3100   server in HTTP mode",
		"npm run dev:logs                 server + app logs in one terminal",
		"npm run dev:logs -- --grep login start with a search applied",
		"npm run dev:logs -- --compact    shorter output, more entries per screen",
		"npm run dev:logs -- --full --headers        everything, including noise",
	]),
	h2("Example tool call with curl"),
	...code([
		"curl -X POST http://127.0.0.1:3100/mcp ^",
		"  -H \"Content-Type: application/json\" ^",
		"  -H \"Accept: application/json, text/event-stream\" ^",
		"  -d \"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":1,\\\"method\\\":\\\"tools/call\\\",",
		"       \\\"params\\\":{\\\"name\\\":\\\"mobile_launch_app\\\",",
		"       \\\"arguments\\\":{\\\"device\\\":\\\"Medium_Phone_API_37.0\\\",\\\"packageName\\\":\\\"com.mli.mspace\\\"}}}\"",
	]),
	h2("Useful tools exposed by the server"),
	table(["Tool", "What it does"], [
		["mobile_list_available_devices", "Lists emulators and devices with the id to use in every other call."],
		["mobile_launch_app / mobile_terminate_app", "Start or stop an app by package name."],
		["mobile_list_elements_on_screen", "Returns the UI tree with refs, text, ids and coordinates. Prefer this over screenshots for finding things to tap."],
		["mobile_click_on_screen_at_coordinates / mobile_type_keys / mobile_swipe_on_screen", "Interact with the screen."],
		["mobile_take_screenshot / mobile_save_screenshot", "Capture the screen, inline or to a file."],
		["mobile_get_device_logs", "Pull logcat with filters such as process=com.mli.mspace when you are not using the dev viewer."],
		["mobile_batch_commands", "Run a known sequence (tap, type, tap) in one round trip."],
	], [40, 60], "orange"),
	spacer(),
	p([run(`Questions or improvements: raise them against the ${BRANCH} branch of the team repository so the fixes land in one place.`, { italics: true, color: MID })]),
);

// =====================================================================
const doc = new Document({
	creator: "Monocept",
	title: "Mobilemcp Team Guide",
	description: "How the Mobilemcp mobile automation works and what each team member needs to set up.",
	customProperties: [
		{ name: "MonoceptBrandSkillVersion", value: SKILL_VERSION },
		{ name: "MonoceptBrandSkillDate", value: SKILL_DATE },
	],
	styles: {
		default: {
			document: { run: { font: BODY_FONT, size: 22, color: BODY }, paragraph: { spacing: { line: 276, after: 120 } } },
			title: { run: { font: HEAD_FONT, size: 72, bold: true, color: ORANGE }, paragraph: { spacing: { before: 0, after: 200 }, keepNext: true } },
			heading1: { run: { font: HEAD_FONT, size: 40, bold: true, color: ORANGE }, paragraph: { spacing: { before: 360, after: 160 }, keepNext: true, numbering: { reference: "headings", level: 0 }, outlineLevel: 0 } },
			heading2: { run: { font: HEAD_FONT, size: 32, bold: false, color: ORANGE }, paragraph: { spacing: { before: 280, after: 120 }, keepNext: true, numbering: { reference: "headings", level: 1 }, outlineLevel: 1 } },
			heading3: { run: { font: BODY_FONT, size: 26, bold: true, color: DARK }, paragraph: { spacing: { before: 200, after: 100 }, keepNext: true, numbering: { reference: "headings", level: 2 }, outlineLevel: 2 } },
			heading4: { run: { font: BODY_FONT, size: 22, bold: true, italics: true, color: DARK }, paragraph: { spacing: { before: 160, after: 80 }, keepNext: true, numbering: { reference: "headings", level: 3 }, outlineLevel: 3 } },
		},
	},
	numbering,
	sections: [{
		properties: {
			page: {
				size: { width: PAGE_W, height: PAGE_H },
				margin: { top: M_TOP, right: M_RIGHT, bottom: M_BOTTOM, left: M_LEFT, header: 709, footer: 709 },
				borders: {
					pageBorders: { display: PageBorderDisplay.ALL_PAGES, offsetFrom: PageBorderOffsetFrom.PAGE, zOrder: PageBorderZOrder.BACK },
					pageBorderTop: { style: BorderStyle.SINGLE, size: 2, color: LINE, space: 24 },
					pageBorderBottom: { style: BorderStyle.SINGLE, size: 2, color: LINE, space: 24 },
					pageBorderLeft: { style: BorderStyle.SINGLE, size: 2, color: LINE, space: 24 },
					pageBorderRight: { style: BorderStyle.SINGLE, size: 2, color: LINE, space: 24 },
				},
			},
		},
		headers: { default: header },
		footers: { default: footer },
		children,
	}],
});

Packer.toBuffer(doc).then(buf => { fs.writeFileSync(OUT, buf); console.log("wrote", OUT, buf.length, "bytes"); });
