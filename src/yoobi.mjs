// Reusable Yoobi browser automation helpers
import { chromium } from "playwright";

const MONTH_NAMES = [
	"Januari", "Februari", "Maart", "April", "Mei", "Juni",
	"Juli", "Augustus", "September", "Oktober", "November", "December",
];

const IFRAME_TIMEOUT = 20000;
const GRID_TIMEOUT = 15000;

const CHROME_ARGS = [
	"--disable-gpu",
	"--disable-dev-shm-usage",
	"--disable-software-rasterizer",
	"--disable-extensions",
	"--disable-background-networking",
	"--disable-default-apps",
	"--disable-sync",
	"--metrics-recording-only",
	"--no-first-run",
	"--disable-background-timer-throttling",
	"--disable-backgrounding-occluded-windows",
	"--disable-component-update",
	"--disable-hang-monitor",
	"--disable-ipc-flooding-protection",
	"--disable-renderer-backgrounding",
];

const BLOCKED_RESOURCE_TYPES = new Set(["image", "stylesheet", "font", "media"]);

export class Yoobi {
	constructor({ baseUrl, username, password }) {
		this.baseUrl = baseUrl.replace(/\/$/, "") + "/";
		this.username = username;
		this.password = password;
		this.browser = null;
		this.page = null;
	}

	async launch() {
		this.browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
		const context = await this.browser.newContext({ viewport: { width: 1280, height: 900 } });
		this.page = await context.newPage();
		this.page.setDefaultTimeout(30000);
		await this.page.route("**/*", (route) => {
			if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) return route.abort();
			return route.continue();
		});
	}

	async close() {
		if (this.browser) await this.browser.close().catch(() => {});
		this.browser = null;
		this.page = null;
	}

	isLoggedIn() {
		if (!this.page) return false;
		try {
			return this.page.url().includes("vue#/");
		} catch {
			return false;
		}
	}

	async ensureReady() {
		if (!this.browser || !this.page) {
			await this.launch();
		}
		if (!this.isLoggedIn()) {
			await this.login();
		}
	}

	async login() {
		await this.page.goto(this.baseUrl, { waitUntil: "load", timeout: 30000 });
		await this.page.getByRole("textbox", { name: "Gebruikersnaam" }).fill(this.username);
		await this.page.getByRole("textbox", { name: "Wachtwoord" }).fill(this.password);
		await this.page.getByRole("button", { name: "Inloggen" }).click();
		await this.page.waitForURL("**/vue#/**", { timeout: 15000 });
		console.log("[yoobi] Logged in");
	}

	// --- Timesheet iframe helpers ---

	async getTimesheetIframe() {
		await this.page.goto(`${this.baseUrl}vue#/timesheet/index`, { waitUntil: "load", timeout: 30000 });

		await this.page.waitForSelector('iframe[src="timesheet/index"]', { timeout: IFRAME_TIMEOUT });
		await this.page.waitForTimeout(2000);

		const iframe = this.page.frameLocator('iframe[src="timesheet/index"]');

		// Wait for employee name to confirm iframe rendered
		await iframe.locator("#employeeName").waitFor({ state: "visible", timeout: GRID_TIMEOUT });

		// Wait for grid row — may not appear for empty months
		try {
			await iframe.locator("#activity_1\\.1-d").waitFor({ state: "visible", timeout: GRID_TIMEOUT });
		} catch {
			// Grid row didn't appear — month may have no activity rows
		}

		return iframe;
	}

	async navigateToMonth(year, month) {
		const now = new Date();
		if (year === now.getFullYear() && month === now.getMonth() + 1) return;

		const targetValue = `${year}-${month}`;
		await this.page.evaluate((value) => {
			const iframe = document.querySelector('iframe[src="timesheet/index"]');
			if (!iframe) throw new Error("Timesheet iframe not found");
			const dropdown = iframe.contentDocument.querySelector("#timesheetPeriod");
			if (!dropdown) throw new Error("Month dropdown not found");
			dropdown.value = value;
			dropdown.dispatchEvent(new Event("change", { bubbles: true }));
		}, targetValue);
		await this.page.waitForTimeout(3000);
	}

	// --- Extraction ---

	async getMonth(year, month) {
		const now = new Date();
		const targetYear = year || now.getFullYear();
		const targetMonth = month || now.getMonth() + 1;

		await this.getTimesheetIframe();
		await this.navigateToMonth(targetYear, targetMonth);

		const iframe = this.page.frameLocator('iframe[src="timesheet/index"]');
		const employeeName = await iframe.locator("#employeeName").textContent().catch(() => "");

		const data = await this.page.evaluate(monthExtractFn, { targetYear, targetMonth });

		const projects = [];
		if (data.total > 0) {
			projects.push({
				daily_hours: data.dailyHours,
				monthly_total: data.total,
			});
		}

		return {
			year: targetYear,
			month: targetMonth,
			month_name: MONTH_NAMES[targetMonth - 1],
			employee_name: (employeeName || "").trim(),
			total_hours: data.total,
			projects,
			validation: {
				official_total: data.officialTotal || 0,
				calculated_total: data.calculatedTotal || 0,
				days_with_data: data.daysCount || 0,
				confidence: data.confidence || 0,
				reason: data.reason || "",
			},
		};
	}

	async getDay(targetDate) {
		const dt = targetDate || new Date().toISOString().split("T")[0];
		const [y, m] = dt.split("-").map(Number);

		await this.getTimesheetIframe();
		await this.navigateToMonth(y, m);

		const hours = await this.page.evaluate(dayExtractFn, { dateStr: dt });

		const entries = [];
		if (hours > 0) {
			entries.push({ hours, date: dt });
		}

		return { date: dt, total_hours: hours, entries };
	}

	// --- Write operations ---

	async registerHours(dateStr, hours) {
		await this.getTimesheetIframe();
		const [y, m] = dateStr.split("-").map(Number);
		await this.navigateToMonth(y, m);

		const iframe = this.page.frameLocator('iframe[src="timesheet/index"]');
		const cell = await this._findCellForDate(iframe, dateStr);
		if (!cell) {
			throw new Error(`Cell not found for date ${dateStr}`);
		}

		// Check existing value
		const cellText = (await cell.textContent()).trim();
		if (cellText) {
			const existing = parseFloat(cellText);
			if (Math.abs(existing - hours) < 0.01) {
				return { date: dateStr, hours, status: "already_exists" };
			}
			return { date: dateStr, hours, existing, status: "conflict" };
		}

		// Double-click cell to open popup, fill hours, submit
		await cell.dblclick();
		const popup = iframe.locator("#timesheetDataGridItemPopupWindow");
		await popup.waitFor({ state: "visible", timeout: 5000 });
		await popup.locator("input.time").fill(hours.toFixed(2));
		await popup.locator("button.defaultaction").click();
		await popup.waitFor({ state: "hidden", timeout: 5000 });

		console.log(`[yoobi] Registered ${hours} hours for ${dateStr}`);
		return { date: dateStr, hours, status: "created" };
	}

	async closeWeek(dateStr) {
		await this.getTimesheetIframe();
		const [y, m] = dateStr.split("-").map(Number);
		await this.navigateToMonth(y, m);

		const iframe = this.page.frameLocator('iframe[src="timesheet/index"]');

		// Find the week containing this date
		const weekInfo = iframe.locator(".periodInfo.weekInfo");
		const count = await weekInfo.count();
		let targetWeek = null;

		for (let i = 0; i < count; i++) {
			const info = weekInfo.nth(i);
			const firstDate = await info.getAttribute("data-firstdate");
			const lastDate = await info.getAttribute("data-lastdate");
			if (firstDate && lastDate && firstDate <= dateStr && dateStr <= lastDate) {
				const weekContainer = info.locator("xpath=..").first();
				const weekClass = await weekContainer.getAttribute("class");
				if (!weekClass) continue;
				const match = weekClass.split(" ").find((c) => c.startsWith("week-"));
				if (match) {
					targetWeek = match.split("-")[1];
					break;
				}
			}
		}

		if (!targetWeek) {
			throw new Error(`Could not find week containing date ${dateStr}`);
		}

		// Check if already closed
		const weekContainer = iframe.locator(`.weeknumber.week-${targetWeek}`);
		const closedState = weekContainer.locator(".state.ifclosed");
		if (await closedState.isVisible()) {
			return { week: parseInt(targetWeek), status: "already_closed" };
		}

		// Open week menu and close
		const weekMenu = iframe.locator(`.weeknumber.week-${targetWeek} a[href="#week${targetWeek}"]`);
		await weekMenu.click();
		await this.page.waitForTimeout(500);

		const closeOption = iframe.locator(`li:has-text("Week ${targetWeek} afsluiten")`);
		await closeOption.click();

		const confirmPopup = iframe.locator(".windowContainer form");
		await confirmPopup.waitFor({ state: "visible", timeout: 5000 });
		const confirmButton = iframe.locator('button.defaultaction.fr span:has-text("Sluiten")');
		await confirmButton.click();

		console.log(`[yoobi] Closed week ${targetWeek}`);
		return { week: parseInt(targetWeek), status: "closed" };
	}

	// --- Cell lookup helper ---

	async _findCellForDate(iframe, dateStr) {
		const selectors = [
			"#activity_1\\.1-d .cell.workweek",
			".cell.workweek",
			".cell",
		];

		for (const selector of selectors) {
			const cells = iframe.locator(selector);
			const count = await cells.count();
			for (let i = 0; i < count; i++) {
				const cell = cells.nth(i);
				const classAttr = await cell.getAttribute("class");
				if (classAttr && classAttr.includes(`date:'${dateStr}'`)) {
					return cell;
				}
			}
		}
		return null;
	}

	// --- Read operations ---

	async getProfile() {
		await this.page.goto(
			`${this.baseUrl}vue#/frame/profile/detail?subroute=profile/detail`,
			{ waitUntil: "load", timeout: 30000 },
		);

		const iframeEl = this.page.locator("iframe").first();
		const frame = iframeEl.contentFrame();
		await frame.locator("body").waitFor({ timeout: 15000 });

		async function extract(label) {
			try {
				const cell = frame.locator(`td:has-text("${label}")`).first();
				const row = cell.locator("xpath=..");
				const value = row.locator("td").last();
				const text = await value.textContent();
				return text?.trim() || null;
			} catch {
				return null;
			}
		}

		return {
			name: (await extract("Naam:")) || "Unknown",
			email: (await extract("E-mailadres:")) || "Unknown",
			phone: await extract("Mobiel nummer:"),
			username: (await extract("Gebruikersnaam:")) || "Unknown",
			last_login: (await extract("Laatste inlogdatum:")) || "Unknown",
		};
	}
}

// --- Extraction functions (passed to page.evaluate, run in browser context) ---

/* eslint-disable no-undef -- these run inside the browser, not Node.js */

function monthExtractFn({ targetYear, targetMonth }) {
	const iframe = document.querySelector('iframe[src="timesheet/index"]');
	if (!iframe || !iframe.contentDocument) {
		return { total: 0, dailyHours: {}, officialTotal: 0, calculatedTotal: 0, daysCount: 0, confidence: 0, reason: "No iframe found" };
	}
	const doc = iframe.contentDocument;

	// Extract official "Totaal deze maand"
	let officialTotal = 0;
	const totalEls = Array.from(doc.querySelectorAll("*")).filter(
		(el) => el.textContent && el.textContent.includes("Totaal deze maand"),
	);
	for (const el of totalEls) {
		const container = el.closest("tr, .row, div") || el.parentElement || el;
		const text = container.textContent || "";
		const patterns = [
			/Totaal deze maand[\s\S]*?(\d+(?:[.,]\d+)?)/,
			/(\d+(?:[.,]\d+)?)\s*(?:uur|hrs?)?\s*Totaal deze maand/i,
			/Totaal[\s\S]*?(\d+(?:[.,]\d+)?)/,
		];
		for (const p of patterns) {
			const m = text.match(p);
			if (m) {
				const v = parseFloat(m[1].replace(",", "."));
				if (v > 0 && v <= 300) { officialTotal = v; break; }
			}
		}
		if (officialTotal > 0) break;
	}

	// Extract daily hours (multi-strategy)
	const dailyHours = {};
	let gridFound = false;
	const datePattern = /\{date:'(\d{4})-(\d{2})-(\d{2})'/;
	const numberPattern = /^\d+(\.\d+)?$/;

	// Strategy 1: div.cell with date pattern in className
	for (const cell of doc.querySelectorAll("div.cell")) {
		const cls = cell.className;
		const txt = (cell.textContent || "").trim();
		if (!txt || !numberPattern.test(txt)) continue;
		const hours = parseFloat(txt);
		if (hours < 0.1 || hours > 24) continue;
		const dm = cls.match(datePattern);
		if (dm) {
			const [, y, mo, d] = dm;
			if (parseInt(y) === targetYear && parseInt(mo) === targetMonth) {
				dailyHours[parseInt(d)] = hours;
				gridFound = true;
			}
		}
	}

	// Strategy 2: .daylytotal cells
	if (!gridFound) {
		for (const cell of doc.querySelectorAll(".daylytotal div.cell")) {
			const txt = (cell.textContent || "").trim();
			if (!txt || !numberPattern.test(txt)) continue;
			const hours = parseFloat(txt);
			if (hours < 0.1 || hours > 24) continue;
			const dm = cell.className.match(datePattern);
			if (dm) {
				const [, y, mo, d] = dm;
				if (parseInt(y) === targetYear && parseInt(mo) === targetMonth) {
					dailyHours[parseInt(d)] = hours;
					gridFound = true;
				}
			}
		}
	}

	// Strategy 3: table-based grid
	if (!gridFound) {
		for (const container of doc.querySelectorAll('table, [class*="timesheet"], [class*="grid"]')) {
			const grids = container.tagName === "TABLE" ? [container] : container.querySelectorAll("table");
			for (const grid of grids) {
				for (const row of grid.querySelectorAll("tr")) {
					const cells = Array.from(row.querySelectorAll("td, th"));
					for (let i = 0; i < cells.length - 1; i++) {
						const dayText = (cells[i].textContent || "").trim();
						const hourText = (cells[i + 1].textContent || "").trim();
						const dayMatch = /^(\d+)$/.exec(dayText);
						const hourMatch = /^(\d+(?:[.,]\d+)?)$/.exec(hourText);
						if (dayMatch && hourMatch) {
							const day = parseInt(dayMatch[1]);
							const h = parseFloat(hourMatch[1].replace(",", "."));
							if (day >= 1 && day <= 31 && h >= 0.25 && h <= 24 && h !== day) {
								dailyHours[day] = h;
								gridFound = true;
							}
						}
					}
					if (gridFound && Object.keys(dailyHours).length > 0) break;
				}
				if (gridFound && Object.keys(dailyHours).length > 0) break;
			}
			if (gridFound && Object.keys(dailyHours).length > 0) break;
		}
	}

	// Validation with confidence scoring
	const calculated = Object.values(dailyHours).reduce((s, h) => s + h, 0);
	const daysCount = Object.keys(dailyHours).length;
	let confidence = 0;
	let reason = "";

	if (officialTotal === 0 && calculated === 0) {
		reason = "No timesheet data found for this month";
	} else if (officialTotal > 0 && daysCount === 0) {
		reason = "Found official total but no daily breakdown";
		confidence = 0.3;
	} else if (officialTotal === 0 && calculated > 0) {
		reason = "Found daily hours but no official total";
		confidence = 0.5;
	} else if (Math.abs(officialTotal - calculated) < 0.01) {
		reason = "Perfect match between official and calculated totals";
		confidence = 1.0;
	} else if (Math.abs(officialTotal - calculated) < 0.5) {
		reason = "Minor discrepancy within acceptable range";
		confidence = 0.9;
	} else {
		reason = "Significant discrepancy: official=" + officialTotal + ", calculated=" + calculated;
		confidence = 0.2;
	}

	return { total: officialTotal || calculated, dailyHours, officialTotal, calculatedTotal: calculated, daysCount, confidence, reason };
}

function dayExtractFn({ dateStr }) {
	const iframe = document.querySelector('iframe[src="timesheet/index"]');
	if (!iframe || !iframe.contentDocument) return 0;
	const doc = iframe.contentDocument;

	const selectors = [
		"#activity_1\\.1-d .cell.workweek",
		".cell.workweek",
		"div.cell",
	];

	for (const selector of selectors) {
		for (const cell of doc.querySelectorAll(selector)) {
			if (!cell.className.includes("date:'" + dateStr + "'")) continue;
			const txt = (cell.textContent || "").trim();
			if (/^\d+(\.\d+)?$/.test(txt)) {
				const h = parseFloat(txt);
				if (h >= 0.1 && h <= 24) return h;
			}
		}
	}
	return 0;
}
