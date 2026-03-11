import http from "node:http";
import crypto from "node:crypto";
import { Yoobi } from "./yoobi.mjs";
import { ApiError } from "./errors.mjs";
import { defineRoutes, generateOpenApiSpec } from "./routes.mjs";

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY;
const BASE_URL = process.env.YOOBI_BASE_URL;
const USERNAME = process.env.YOOBI_USERNAME;
const PASSWORD = process.env.YOOBI_PASSWORD;
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || "300000", 10); // 5 min
const HANDLER_TIMEOUT_MS = parseInt(process.env.HANDLER_TIMEOUT_MS || "120000", 10); // 2 min
const READONLY = process.env.READONLY === "true";

if (!BASE_URL || !USERNAME || !PASSWORD) {
	console.error("Missing required env vars: YOOBI_BASE_URL, YOOBI_USERNAME, YOOBI_PASSWORD");
	process.exit(1);
}

// --- Session management ---

const session = {
	yoobi: new Yoobi({ baseUrl: BASE_URL, username: USERNAME, password: PASSWORD }),
	mutex: null,
	idleTimer: null,
	startedAt: new Date().toISOString(),
	lastRequestAt: null,
};

function resetIdleTimer() {
	if (session.idleTimer) clearTimeout(session.idleTimer);
	session.idleTimer = setTimeout(async () => {
		if (session.mutex) return; // request in progress, skip
		console.log("[session] Idle timeout — closing browser");
		await session.yoobi.close();
	}, IDLE_TIMEOUT_MS);
}

function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Handler timed out after ${ms / 1000}s`)), ms);
		promise.then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
}

async function withBrowser(handler) {
	while (session.mutex) {
		await session.mutex;
	}

	let resolve;
	session.mutex = new Promise((r) => { resolve = r; });

	try {
		try {
			await session.yoobi.ensureReady();
			const result = await withTimeout(handler(session.yoobi), HANDLER_TIMEOUT_MS);
			session.lastRequestAt = new Date().toISOString();
			resetIdleTimer();
			return result;
		} catch (err) {
			if (err instanceof ApiError) throw err;

			console.error(`[session] Request failed, retrying with fresh session: ${err.message}`);
			await session.yoobi.close();
			try {
				await session.yoobi.ensureReady();
				const result = await withTimeout(handler(session.yoobi), HANDLER_TIMEOUT_MS);
				session.lastRequestAt = new Date().toISOString();
				resetIdleTimer();
				return result;
			} catch (retryErr) {
				console.error(`[session] Retry also failed, closing browser: ${retryErr.message}`);
				await session.yoobi.close();
				throw retryErr;
			}
		}
	} finally {
		session.mutex = null;
		resolve();
	}
}

// --- Routes ---

const routes = defineRoutes({ withBrowser, readonly: READONLY });

routes.find((r) => r.path === "/api/health").handler = () => ({
	ok: true,
	browserActive: !!session.yoobi.browser,
	loggedIn: session.yoobi.isLoggedIn(),
	startedAt: session.startedAt,
	uptimeSeconds: Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000),
	lastRequestAt: session.lastRequestAt,
});

const openApiSpec = generateOpenApiSpec(routes);

// Index routes
const routeMap = new Map();
for (const route of routes) {
	routeMap.set(`${route.method} ${route.path}`, route);
}

// --- HTTP helpers ---

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_SIZE) throw new ApiError(413, "Request body too large");
		chunks.push(chunk);
	}
	if (size === 0) return null;
	return JSON.parse(Buffer.concat(chunks).toString());
}

function json(res, status, data) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

// --- Server ---

const server = http.createServer(async (req, res) => {
	const start = Date.now();
	const url = new URL(req.url, `http://localhost:${PORT}`);

	// Root — service description for humans and AI agents
	if (url.pathname === "/") {
		return json(res, 200, {
			name: "Yoobi API",
			description: "Yoobi timesheet API via browser automation. Read and write timesheet hours, close weeks, and extract profile data from the Yoobi web UI using Playwright.",
			docs: "/api/docs",
			health: "/api/health",
			endpoints: routes.map((r) => ({ method: r.method, path: r.path, summary: r.summary, auth: r.auth })),
		});
	}

	if (url.pathname === "/api/docs") {
		return json(res, 200, openApiSpec);
	}

	const route = routeMap.get(`${req.method} ${url.pathname}`);
	if (!route) {
		console.log(`${req.method} ${url.pathname} 404 ${Date.now() - start}ms`);
		return json(res, 404, { error: "Not found" });
	}

	if (route.auth && API_KEY) {
		const auth = req.headers.authorization || "";
		const expected = `Bearer ${API_KEY}`;
		const ok = auth.length === expected.length
			&& crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
		if (!ok) {
			console.log(`${req.method} ${url.pathname} 401 ${Date.now() - start}ms`);
			return json(res, 401, { error: "Unauthorized" });
		}
	}

	const query = Object.fromEntries(url.searchParams);

	try {
		let body = null;
		if (req.method === "POST") {
			body = await readBody(req);
		}
		const result = await route.handler(query, body);
		console.log(`${req.method} ${url.pathname} 200 ${Date.now() - start}ms`);
		return json(res, 200, result);
	} catch (err) {
		const status = err.status || 500;
		const message = err.message || String(err);
		console.log(`${req.method} ${url.pathname} ${status} ${Date.now() - start}ms`);
		console.error(`[${url.pathname}] Error: ${message}`);
		const clientMessage = status < 500 ? message : "Internal server error";
		return json(res, status, { error: clientMessage });
	}
});

server.listen(PORT, () => {
	console.log(`Yoobi API listening on port ${PORT}`);
	console.log(`Mode: ${READONLY ? "read-only" : "read-write"}`);
	console.log(`Auth: ${API_KEY ? "enabled" : "disabled (no API_KEY set)"}`);
	console.log(`Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
	console.log(`API docs: http://localhost:${PORT}/api/docs`);
});

// Graceful shutdown
async function shutdown(signal) {
	console.log(`[shutdown] ${signal} received — closing browser and server`);
	if (session.idleTimer) clearTimeout(session.idleTimer);
	await session.yoobi.close();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
