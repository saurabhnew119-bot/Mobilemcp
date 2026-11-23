#!/usr/bin/env node
// One command to bring everything up: `npm run dev`
//
//   1. installs dependencies if node_modules is missing
//   2. builds lib/ if it is missing or older than src/
//   3. boots the Android emulator (unless a device is already online) and
//      waits until Android has finished booting
//   4. launches the app under test if it is installed and not running
//   5. hands this terminal to the dev log viewer (scripts/dev-logs.mjs),
//      which starts the MCP server and streams server + app logs
//
//   node scripts/start.mjs [--avd <name>] [--no-emulator] [--no-app]
//                          [--no-build] [--boot-timeout <seconds>]
//                          [--stop-emulator]  [...any dev-logs flag]
//
// --avd            AVD to boot (default: first from `emulator -list-avds`)
// --no-emulator    never boot an emulator; use whatever adb already sees
// --no-app         do not launch the app; just attach when it starts
// --no-build       skip the dependency/build check
// --boot-timeout   seconds to wait for the emulator to boot (default 240)
// --stop-emulator  shut down an emulator this script booted when you quit
//
// All other flags (--package, --device, --port, --compact, --grep, ...) are
// passed through to dev-logs. The emulator keeps running after you quit
// unless --stop-emulator is given, so the next start is instant.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";

// ---------- args ----------
const argv = process.argv.slice(2);
const OWN_FLAGS = new Set(["--no-emulator", "--no-app", "--no-build", "--stop-emulator"]);
const OWN_OPTS = new Set(["--avd", "--boot-timeout"]);
const flag = name => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const passThrough = [];
for (let i = 0; i < argv.length; i++) {
	if (OWN_FLAGS.has(argv[i])) {
		continue;
	}

	if (OWN_OPTS.has(argv[i])) {
		i++;
		continue;
	}

	passThrough.push(argv[i]);
}

const PACKAGE = opt("package", "com.mli.mspace");
const WANTED_DEVICE = opt("device", null);
const BOOT_TIMEOUT_MS = (Number(opt("boot-timeout", "240")) || 240) * 1000;

// ---------- output ----------
const COLOR = process.stdout.isTTY && !flag("no-color");
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const step = s => console.log(`${c("36", "›")} ${s}`);
const ok = s => console.log(`${c("32", "✓")} ${s}`);
const warn = s => console.log(`${c("33", "!")} ${s}`);
const fail = s => {
	console.error(`${c("31", "✗")} ${s}`);
	process.exit(1);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Android SDK ----------
const sdkCandidates = [
	process.env.ANDROID_HOME,
	process.env.ANDROID_SDK_ROOT,
	IS_WIN && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk"),
	!IS_WIN && process.env.HOME && join(process.env.HOME, process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk"),
].filter(Boolean);
const SDK = sdkCandidates.find(p => existsSync(p));
const exe = name => (IS_WIN ? `${name}.exe` : name);
const ADB = process.env.ADB || (SDK ? join(SDK, "platform-tools", exe("adb")) : exe("adb"));
const EMULATOR = SDK ? join(SDK, "emulator", exe("emulator")) : exe("emulator");

const adb = (args, opts = {}) => {
	try {
		return execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 15000, ...opts }).trim();
	} catch {
		return null;
	}
};

// [{ serial, state }] for every device adb knows about
const listDevices = () => (adb(["devices"]) ?? "")
	.split(/\r?\n/)
	.slice(1)
	.map(line => line.trim().split(/\s+/))
	.filter(parts => parts.length >= 2)
	.map(([serial, state]) => ({ serial, state }));

const isBooted = serial => adb(["-s", serial, "shell", "getprop", "sys.boot_completed"]) === "1";

// ---------- 1 + 2: dependencies and build ----------
const newestMtime = dir => {
	let newest = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
	}

	return newest;
};

const runOrFail = (label, command, args) => {
	step(label);
	// npm is a .cmd shim on Windows, so it needs a shell there
	const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: IS_WIN && command === "npm" });
	if (result.status !== 0) {
		fail(`${label} failed`);
	}
};

const ensureBuilt = () => {
	if (!existsSync(join(ROOT, "node_modules"))) {
		runOrFail("Installing dependencies (npm install)", "npm", ["install"]);
	}

	const libIndex = join(ROOT, "lib", "index.js");
	const stale = !existsSync(libIndex) || newestMtime(join(ROOT, "src")) > statSync(libIndex).mtimeMs;
	if (stale) {
		runOrFail("Building (tsc)", process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc")]);
		ok("Build up to date");
	} else {
		ok("Build up to date (lib/ is newer than src/)");
	}
};

// ---------- 3: emulator ----------
let bootedHere = null; // serial of an emulator this script started

const pickAvd = () => {
	const wanted = opt("avd", null);
	if (wanted) {
		return wanted;
	}

	if (!existsSync(EMULATOR) && SDK) {
		fail(`Android emulator not found at ${EMULATOR}. Install "Android Emulator" from Android Studio > SDK Manager.`);
	}

	let avds = [];
	try {
		avds = execFileSync(EMULATOR, ["-list-avds"], { encoding: "utf8", windowsHide: true })
			.split(/\r?\n/)
			.map(s => s.trim())
			// newer emulator builds print INFO/WARNING lines here as well
			.filter(s => s && !/^(INFO|WARNING|ERROR)\b/.test(s));
	} catch (err) {
		fail(`Could not run "${EMULATOR} -list-avds": ${err.message}`);
	}

	if (avds.length === 0) {
		fail("No Android Virtual Device found. Create one in Android Studio > Device Manager, or connect a phone with USB debugging.");
	}

	if (avds.length > 1) {
		warn(`Several AVDs found (${avds.join(", ")}); using ${avds[0]}. Pick another with --avd <name>.`);
	}

	return avds[0];
};

const waitFor = async (label, check) => {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const value = check();
		if (value) {
			return value;
		}

		await sleep(2000);
	}

	fail(`Timed out after ${BOOT_TIMEOUT_MS / 1000}s waiting for ${label}. Raise it with --boot-timeout <seconds>.`);
};

// The emulator's qemu process starts netsimd.exe (network simulator), a
// console program. If the emulator has no console of its own (a detached
// spawn), Windows opens a new, visible terminal window for netsimd. So on
// Windows the emulator is started through a hidden cmd with `start /b`: it
// shares cmd's invisible console, which netsimd then inherits. Being a
// grandchild, it also escapes Node's kill-on-exit job object and keeps
// running after this script quits.
const startEmulator = args => {
	const emu = IS_WIN
		? spawn("cmd.exe", ["/d", "/s", "/c", `"start "" /b "${EMULATOR}" ${args.map(a => `"${a}"`).join(" ")}"`], {
			stdio: "ignore",
			windowsHide: true,
			windowsVerbatimArguments: true,
		})
		: spawn(EMULATOR, args, { detached: true, stdio: "ignore" });
	emu.on("error", err => fail(`Could not start the emulator: ${err.message}`));
	emu.unref();
};

const ensureDevice = async () => {
	if (!existsSync(ADB) && SDK) {
		fail(`adb not found at ${ADB}. Install "Android SDK Platform-Tools" from Android Studio > SDK Manager, or set ADB=<path to adb>.`);
	}

	adb(["start-server"], { timeout: 30000 });
	const devices = listDevices();

	if (WANTED_DEVICE) {
		const found = devices.find(d => d.serial === WANTED_DEVICE);
		if (found?.state === "device") {
			ok(`Using device ${WANTED_DEVICE}`);
			return WANTED_DEVICE;
		}

		if (!WANTED_DEVICE.startsWith("emulator-") || flag("no-emulator")) {
			fail(`Device ${WANTED_DEVICE} is not online (adb devices: ${devices.map(d => `${d.serial} ${d.state}`).join(", ") || "none"}).`);
		}
	} else {
		const online = devices.find(d => d.state === "device");
		if (online) {
			ok(`Using device ${online.serial} (already running)`);
			return online.serial;
		}
	}

	if (flag("no-emulator")) {
		step("Waiting for a device to come online (--no-emulator)");
		return waitFor("a device", () => listDevices().find(d => d.state === "device")?.serial);
	}

	const avd = pickAvd();
	const before = new Set(devices.map(d => d.serial));
	const args = ["-avd", avd];
	if (WANTED_DEVICE) {
		// emulator-5554 → console port 5554
		args.push("-port", WANTED_DEVICE.replace("emulator-", ""));
	}

	step(`Starting emulator ${avd} (it opens in its own window)`);
	startEmulator(args);

	const serial = await waitFor("the emulator to appear in adb", () => {
		const list = listDevices();
		return (WANTED_DEVICE && list.some(d => d.serial === WANTED_DEVICE) ? WANTED_DEVICE : null)
			?? list.find(d => d.serial.startsWith("emulator-") && !before.has(d.serial))?.serial;
	});
	bootedHere = serial;

	step(`Waiting for Android to finish booting on ${serial}`);
	await waitFor("Android to boot", () => isBooted(serial));
	ok(`Emulator ${avd} is ready (${serial})`);
	return serial;
};

// ---------- 4: app ----------
const ensureApp = serial => {
	if (flag("no-app")) {
		return;
	}

	const installed = (adb(["-s", serial, "shell", "pm", "list", "packages", PACKAGE]) ?? "")
		.split(/\r?\n/)
		.some(line => line.trim() === `package:${PACKAGE}`);
	if (!installed) {
		warn(`${PACKAGE} is not installed on ${serial}; install the APK and the viewer will attach once it runs.`);
		return;
	}

	if (adb(["-s", serial, "shell", "pidof", PACKAGE])) {
		ok(`${PACKAGE} is already running`);
		return;
	}

	step(`Launching ${PACKAGE}`);
	adb(["-s", serial, "shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"]);
};

// ---------- 5: hand over to the log viewer ----------
const runViewer = serial => {
	const args = [join(ROOT, "scripts", "dev-logs.mjs"), ...passThrough];
	if (!WANTED_DEVICE) {
		args.push("--device", serial);
	}

	ok("Starting MCP server and log viewer…\n");
	const viewer = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ADB } });

	// Ctrl+C reaches the viewer directly; this process just waits for it.
	process.on("SIGINT", () => {});
	viewer.on("exit", code => {
		if (bootedHere && flag("stop-emulator")) {
			console.log(`Stopping emulator ${bootedHere}`);
			adb(["-s", bootedHere, "emu", "kill"]);
		}

		process.exit(code ?? 0);
	});
};

// ---------- main ----------
if (!flag("no-build")) {
	ensureBuilt();
}

const serial = await ensureDevice();
ensureApp(serial);
runViewer(serial);
