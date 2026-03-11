// Route definitions — single source of truth for endpoints + OpenAPI spec
import { ApiError } from "./errors.mjs";

export function defineRoutes({ withBrowser, readonly }) {
	return [
		{
			method: "GET",
			path: "/api/health",
			summary: "Health check",
			auth: false,
			handler: null, // Set by server.mjs (needs session access)
		},
		{
			method: "GET",
			path: "/api/month",
			summary: "Monthly timesheet",
			description: "Monthly timesheet with daily breakdown and validation.",
			auth: true,
			query: {
				year: { type: "integer", description: "Year (default: current)" },
				month: { type: "integer", description: "Month 1-12 (default: current)" },
			},
			handler: (query) => {
				const year = query.year ? parseInt(query.year) : undefined;
				const month = query.month ? parseInt(query.month) : undefined;
				if (year !== undefined && (isNaN(year) || year < 2000 || year > 2100)) {
					throw new ApiError(400, "Invalid year (must be 2000-2100)");
				}
				if (month !== undefined && (isNaN(month) || month < 1 || month > 12)) {
					throw new ApiError(400, "Invalid month (must be 1-12)");
				}
				return withBrowser((yoobi) => yoobi.getMonth(year, month));
			},
		},
		{
			method: "GET",
			path: "/api/week",
			summary: "This week's hours",
			description: "Current week hours derived from the monthly view.",
			auth: true,
			handler: () =>
				withBrowser(async (yoobi) => {
					const now = new Date();
					const data = await yoobi.getMonth(now.getFullYear(), now.getMonth() + 1);

					const today = new Date();
					const monday = new Date(today);
					monday.setDate(today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1));

					const dailyHours = {};
					for (const project of data.projects || []) {
						for (const [dayStr, hours] of Object.entries(project.daily_hours || {})) {
							const day = parseInt(dayStr);
							try {
								const d = new Date(today.getFullYear(), today.getMonth(), day);
								if (d >= monday && d <= today) {
									const iso = d.toISOString().split("T")[0];
									dailyHours[iso] = (dailyHours[iso] || 0) + hours;
								}
							} catch {
								continue;
							}
						}
					}

					// Fill missing workdays
					for (let i = 0; i < 5; i++) {
						const d = new Date(monday);
						d.setDate(monday.getDate() + i);
						if (d <= today) {
							const iso = d.toISOString().split("T")[0];
							if (!(iso in dailyHours)) dailyHours[iso] = 0;
						}
					}

					const sorted = Object.fromEntries(Object.entries(dailyHours).sort());
					const sunday = new Date(monday);
					sunday.setDate(monday.getDate() + 6);

					return {
						week_start: monday.toISOString().split("T")[0],
						week_end: sunday.toISOString().split("T")[0],
						daily_hours: sorted,
						total_hours: Object.values(dailyHours).reduce((s, h) => s + h, 0),
					};
				}),
		},
		{
			method: "GET",
			path: "/api/today",
			summary: "Today's hours",
			description: "Timesheet entry for today.",
			auth: true,
			handler: () => withBrowser((yoobi) => yoobi.getDay()),
		},
		{
			method: "GET",
			path: "/api/day",
			summary: "Hours for a specific date",
			description: "Timesheet entry for a specific date.",
			auth: true,
			query: {
				date: { type: "string", description: "Date in YYYY-MM-DD format", required: true },
			},
			handler: (query) => {
				if (!query.date || !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
					throw new ApiError(400, "Missing or invalid query parameter: date (YYYY-MM-DD)");
				}
				return withBrowser((yoobi) => yoobi.getDay(query.date));
			},
		},
		{
			method: "GET",
			path: "/api/profile",
			summary: "User profile",
			description: "Yoobi user profile information.",
			auth: true,
			handler: () => withBrowser((yoobi) => yoobi.getProfile()),
		},
		// Write endpoints (disabled when READONLY=true)
		...(!readonly ? [{
			method: "POST",
			path: "/api/hours",
			summary: "Register hours",
			description: "Register hours for one or more days. Hours are rounded to the nearest quarter. Existing entries with the same value are skipped (idempotent).",
			auth: true,
			body: {
				entries: {
					type: "array",
					description: "Array of { date: 'YYYY-MM-DD', hours: number }",
					required: true,
				},
			},
			handler: (query, body) => {
				if (!body || !Array.isArray(body.entries) || body.entries.length === 0) {
					throw new ApiError(400, "Missing or empty 'entries' array");
				}
				if (body.entries.length > 31) {
					throw new ApiError(400, "Maximum 31 entries per request");
				}

				for (const entry of body.entries) {
					if (!entry.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
						throw new ApiError(400, `Invalid date format: ${entry.date} (expected YYYY-MM-DD)`);
					}
					if (typeof entry.hours !== "number" || entry.hours < 0.25 || entry.hours > 24) {
						throw new ApiError(400, `Invalid hours for ${entry.date}: must be 0.25-24`);
					}
				}

				// Round to nearest quarter
				const rounded = body.entries.map((e) => ({
					date: e.date,
					hours: Math.round(e.hours * 4) / 4,
				}));

				return withBrowser(async (yoobi) => {
					const results = [];
					for (const entry of rounded) {
						try {
							const result = await yoobi.registerHours(entry.date, entry.hours);
							results.push(result);
						} catch (err) {
							results.push({ date: entry.date, hours: entry.hours, status: "failed", error: err.message });
						}
					}
					return { results };
				});
			},
		},
		{
			method: "POST",
			path: "/api/week/close",
			summary: "Close a week",
			description: "Close/submit a week in the timesheet. The week is identified by any date that falls within it.",
			auth: true,
			body: {
				date: { type: "string", description: "Any date within the week (YYYY-MM-DD)", required: true },
			},
			handler: (query, body) => {
				if (!body || !body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
					throw new ApiError(400, "Missing or invalid 'date' (YYYY-MM-DD)");
				}
				return withBrowser((yoobi) => yoobi.closeWeek(body.date));
			},
		}] : []),
	];
}

export function generateOpenApiSpec(routes) {
	const paths = {};
	for (const route of routes) {
		const path = route.path.replace(/:(\w+)/g, "{$1}");
		const parameters = [];

		if (route.query) {
			for (const [name, schema] of Object.entries(route.query)) {
				parameters.push({
					name,
					in: "query",
					required: !!schema.required,
					description: schema.description || "",
					schema: { type: schema.type || "string" },
				});
			}
		}

		const operation = {
			summary: route.summary || "",
			description: route.description || "",
			responses: { 200: { description: "Success" } },
		};
		if (parameters.length) operation.parameters = parameters;
		if (route.body) {
			const properties = {};
			const required = [];
			for (const [name, schema] of Object.entries(route.body)) {
				properties[name] = { type: schema.type || "string", description: schema.description || "" };
				if (schema.required) required.push(name);
			}
			operation.requestBody = {
				required: true,
				content: { "application/json": { schema: { type: "object", properties, required } } },
			};
		}
		if (route.auth) {
			operation.security = [{ bearerAuth: [] }];
		}

		paths[path] = { [route.method.toLowerCase()]: operation };
	}

	return {
		openapi: "3.0.3",
		info: { title: "Yoobi API", version: "1.0.0", description: "Yoobi timesheet API via browser automation" },
		servers: [{ url: "/" }],
		paths,
		components: {
			securitySchemes: {
				bearerAuth: { type: "http", scheme: "bearer" },
			},
		},
	};
}
