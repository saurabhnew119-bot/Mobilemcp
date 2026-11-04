import { NextFunction, Request, Response } from "express";
import { trace } from "./logger";

let requestCounter = 0;

const pretty = (value: unknown): string => {
	if (value === undefined) {
		return "<empty>";
	}

	if (typeof value === "string") {
		return value;
	}

	return JSON.stringify(value, null, 2);
};

// Streamable HTTP responses come back as SSE ("event: message\ndata: {...}").
// Pull the JSON-RPC payloads out of the data: lines so the log stays readable.
const extractSseData = (raw: string): string => {
	const payloads = raw
		.split("\n")
		.filter(line => line.startsWith("data: "))
		.map(line => line.substring("data: ".length));

	if (payloads.length === 0) {
		return raw;
	}

	return payloads
		.map(payload => {
			try {
				return pretty(JSON.parse(payload));
			} catch {
				return payload;
			}
		})
		.join("\n");
};

/**
 * Express middleware that logs every HTTP request body and response body
 * passing through the MCP endpoint. Disable with MOBILEMCP_LOG_REQUESTS=0.
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
	if (process.env.MOBILEMCP_LOG_REQUESTS === "0") {
		next();
		return;
	}

	const id = ++requestCounter;
	const startedAt = Date.now();
	const chunks: Buffer[] = [];

	trace(`\n>>> [#${id}] ${req.method} ${req.originalUrl}\n${pretty(req.body)}`);

	const originalWrite = res.write.bind(res);
	const originalEnd = res.end.bind(res);

	res.write = ((chunk: any, ...args: any[]) => {
		if (chunk) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}

		return originalWrite(chunk, ...args);
	}) as typeof res.write;

	res.end = ((chunk: any, ...args: any[]) => {
		if (chunk && typeof chunk !== "function") {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}

		const body = Buffer.concat(chunks).toString("utf8");
		const elapsed = Date.now() - startedAt;
		trace(`<<< [#${id}] ${res.statusCode} (${elapsed} ms)\n${extractSseData(body)}\n`);

		return originalEnd(chunk, ...args);
	}) as typeof res.end;

	next();
};
