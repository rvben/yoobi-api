#!/usr/bin/env node
// CLI for one-off Yoobi operations without running the server.
// Usage: node src/cli.mjs <command> [args]

import { Yoobi } from "./yoobi.mjs";

const commands = {
	month: {
		usage: "month [year] [month]",
		description: "Get monthly timesheet",
		run: (yoobi, args) => yoobi.getMonth(args[0] ? parseInt(args[0]) : undefined, args[1] ? parseInt(args[1]) : undefined),
	},
	week: {
		usage: "week",
		description: "Get this week's hours (derived from monthly view)",
		run: async (yoobi) => {
			const now = new Date();
			const data = await yoobi.getMonth(now.getFullYear(), now.getMonth() + 1);
			const today = new Date();
			const monday = new Date(today);
			monday.setDate(today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1));
			const dailyHours = {};
			for (const project of data.projects || []) {
				for (const [dayStr, hours] of Object.entries(project.daily_hours || {})) {
					const day = parseInt(dayStr);
					const d = new Date(today.getFullYear(), today.getMonth(), day);
					if (d >= monday && d <= today) {
						const iso = d.toISOString().split("T")[0];
						dailyHours[iso] = (dailyHours[iso] || 0) + hours;
					}
				}
			}
			return { week_start: monday.toISOString().split("T")[0], daily_hours: dailyHours, total_hours: Object.values(dailyHours).reduce((s, h) => s + h, 0) };
		},
	},
	today: {
		usage: "today",
		description: "Get today's hours",
		run: (yoobi) => yoobi.getDay(),
	},
	day: {
		usage: "day <YYYY-MM-DD>",
		description: "Get hours for a specific date",
		run: (yoobi, args) => {
			if (!args[0]) { console.error("Usage: day <YYYY-MM-DD>"); process.exit(1); }
			return yoobi.getDay(args[0]);
		},
	},
	profile: {
		usage: "profile",
		description: "Get user profile",
		run: (yoobi) => yoobi.getProfile(),
	},
	hours: {
		usage: "hours <YYYY-MM-DD> <hours>",
		description: "Register hours for a date (rounded to nearest quarter)",
		run: (yoobi, args) => {
			if (!args[0] || !args[1]) { console.error("Usage: hours <YYYY-MM-DD> <hours>"); process.exit(1); }
			const hours = Math.round(parseFloat(args[1]) * 4) / 4;
			return yoobi.registerHours(args[0], hours);
		},
	},
	"close-week": {
		usage: "close-week <YYYY-MM-DD>",
		description: "Close the week containing the given date",
		run: (yoobi, args) => {
			if (!args[0]) { console.error("Usage: close-week <YYYY-MM-DD>"); process.exit(1); }
			return yoobi.closeWeek(args[0]);
		},
	},
};

const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || command === "--help") {
	console.log("Usage: node src/cli.mjs <command> [args]\n");
	console.log("Commands:");
	for (const [name, cmd] of Object.entries(commands)) {
		console.log(`  ${cmd.usage.padEnd(30)} ${cmd.description}`);
	}
	process.exit(0);
}

if (!commands[command]) {
	console.error(`Unknown command: ${command}. Run with --help for usage.`);
	process.exit(1);
}

const BASE_URL = process.env.YOOBI_BASE_URL;
const USERNAME = process.env.YOOBI_USERNAME;
const PASSWORD = process.env.YOOBI_PASSWORD;

if (!BASE_URL || !USERNAME || !PASSWORD) {
	console.error("Missing env vars: YOOBI_BASE_URL, YOOBI_USERNAME, YOOBI_PASSWORD");
	process.exit(1);
}

const yoobi = new Yoobi({ baseUrl: BASE_URL, username: USERNAME, password: PASSWORD });

try {
	await yoobi.launch();
	await yoobi.login();
	const result = await commands[command].run(yoobi, args);
	console.log(JSON.stringify(result, null, 2));
} catch (err) {
	console.error(`Error: ${err.message}`);
	process.exit(1);
} finally {
	await yoobi.close();
}
